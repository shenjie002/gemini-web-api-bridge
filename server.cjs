/**
 * Gemini Bridge Server v2.0 — Bidirectional Bridge
 * Zero dependencies — Node.js built-in http + crypto
 *
 * Architecture:
 *   Pi Provider  →  POST /api/bridge/completions  (long-poll, blocks until response)
 *   Extension    →  GET  /api/bridge/pending       (polls for pending prompts)
 *   Extension    →  POST /api/bridge/result         (returns Gemini's response)
 *
 * Usage: node server.cjs [port]
 * Default port: 3456
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = parseInt(process.argv[2] || '3456', 10);
const TIMEOUT_MS = 180_000; // 3 min max wait for Gemini response
const POLL_INTERVAL_HINT = 2000; // suggested poll interval for extension

// ── Pending Requests Store ─────────────────────────────────────────
// Map<requestId, { prompt, resolve, reject, timer, status, timestamp }>
const pending = new Map();
let totalCompleted = 0;
let totalErrors = 0;

// ── Helpers ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function ts() {
  return new Date().toISOString();
}

/**
 * Build the prompt that will be typed into Gemini.
 * Gemini responds naturally in plain text. When tools are available,
 * it uses @@TOOL_CALL@@ markers to invoke them.
 */
function composePiPrompt(piRequest) {
  const parts = [];

  // System prompt
  if (piRequest.systemPrompt) {
    parts.push(piRequest.systemPrompt);
  }

  // Available tools + invocation format
  if (piRequest.tools && piRequest.tools.length > 0) {
    const toolsDef = piRequest.tools.map((t) => {
      const params = t.parameters
        ? JSON.stringify(t.parameters)
        : '{}';
      return `- ${t.name}: ${t.description || '(no description)'}\n  Parameters schema: ${params}`;
    });
    parts.push(
      `You have access to the following tools:\n${toolsDef.join('\n\n')}\n\n` +
      `When you need to use a tool, output it using these EXACT text markers (one block per tool call):\n\n` +
      `@@TOOL_CALL@@\n` +
      `{"id":"call_1","name":"tool_name","arguments":{"param":"value"}}\n` +
      `@@END_TOOL_CALL@@\n\n` +
      `CRITICAL JSON Rules:\n` +
      `- The JSON inside @@TOOL_CALL@@ MUST be valid JSON\n` +
      `- All string values containing special characters (quotes, backslashes, newlines) MUST be properly escaped:\n` +
      `  - Use \\" for double quotes inside strings\n` +
      `  - Use \\n for newlines inside strings\n` +
      `  - Use \\\\ for literal backslashes\n` +
      `- Example with special chars: {"id":"call_1","name":"bash","arguments":{"command":"echo \\"hello\\""}}\n` +
      `- You may include explanatory text BEFORE tool calls\n` +
      `- Each @@TOOL_CALL@@ block must contain exactly one JSON object with id, name, and arguments\n` +
      `- The id must be unique across calls in one response (call_1, call_2, ...)\n` +
      `- arguments must be valid JSON matching the tool parameter schema\n` +
      `- After the last @@END_TOOL_CALL@@ do NOT add any more text\n` +
      `- You can make multiple tool calls in one response\n` +
      `- If you do NOT need any tool, just respond with plain text as usual`
    );
  }

  // Conversation history
  if (piRequest.messages && piRequest.messages.length > 0) {
    const formatted = piRequest.messages.map((msg) => {
      const role = msg.role === 'user' ? 'Human'
        : msg.role === 'assistant' ? 'Assistant'
        : msg.role === 'toolResult' ? 'Tool Result'
        : msg.role;
      const content = formatContent(msg);
      return `${role}: ${content}`;
    });
    parts.push(formatted.join('\n\n'));
  }

  return parts.join('\n\n');
}

function formatContent(msg) {
  // toolResult message
  if (msg.role === 'toolResult') {
    const text = extractText(msg.content);
    const prefix = msg.isError ? '(ERROR) ' : '';
    return `[toolResult for ${msg.toolName} / ${msg.toolCallId}]\n${prefix}${text}`;
  }

  const content = msg.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'thinking') return `<thinking>${block.thinking}</thinking>`;
      if (block.type === 'toolCall')
        return `<toolCall name="${block.name}" id="${block.id}">${JSON.stringify(block.arguments)}</toolCall>`;
      return JSON.stringify(block);
    })
    .join('\n');
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ── HTTP Server ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url;
  const method = req.method;

  try {
    // ── GET /health ──
    if (method === 'GET' && url === '/health') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          pending: pending.size,
          completed: totalCompleted,
          errors: totalErrors,
          uptime: Math.round(process.uptime()),
        })
      );
      return;
    }

    // ── POST /api/bridge/completions ──
    // Pi provider sends piRequest here and blocks until Gemini responds.
    if (method === 'POST' && url === '/api/bridge/completions') {
      const body = await readBody(req);
      let piRequest;
      try {
        const data = JSON.parse(body);
        // Accept both wrapped { piRequest: "..." } and raw piRequest
        piRequest =
          typeof data.piRequest === 'string'
            ? JSON.parse(data.piRequest)
            : data.piRequest || data;
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
        return;
      }

      const requestId = crypto.randomUUID();
      const prompt = composePiPrompt(piRequest);

      console.log(
        `${ts()} [COMPLETIONS] ⬇️  requestId=${requestId} prompt=${prompt.length} chars`
      );

      // Long-poll: create a promise that resolves when extension posts result
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          totalErrors++;
          reject(
            new Error(
              `Timeout: Gemini extension did not respond within ${TIMEOUT_MS / 1000}s`
            )
          );
        }, TIMEOUT_MS);

        pending.set(requestId, {
          requestId,
          prompt,
          status: 'pending',
          timestamp: Date.now(),
          resolve: (result) => {
            clearTimeout(timer);
            pending.delete(requestId);
            totalCompleted++;
            resolve(result);
          },
          reject: (err) => {
            clearTimeout(timer);
            pending.delete(requestId);
            totalErrors++;
            reject(err);
          },
        });
      });

      console.log(
        `${ts()} [COMPLETIONS] ⬆️  requestId=${requestId} response=${(result.text || '').length} chars`
      );

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // ── GET /api/bridge/pending ──
    // Extension polls this to pick up pending prompts.
    if (method === 'GET' && url === '/api/bridge/pending') {
      for (const [id, entry] of pending) {
        if (entry.status === 'pending') {
          entry.status = 'dispatched';
          console.log(
            `${ts()} [PENDING] 📋 Dispatching requestId=${id} (${entry.prompt.length} chars)`
          );
          res.writeHead(200);
          res.end(
            JSON.stringify({
              requestId: id,
              prompt: entry.prompt,
            })
          );
          return;
        }
      }
      // Nothing pending
      res.writeHead(200);
      res.end(JSON.stringify({ requestId: null }));
      return;
    }

    // ── POST /api/bridge/result ──
    // Extension posts Gemini's response text here.
    if (method === 'POST' && url === '/api/bridge/result') {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const { requestId, text, error } = data;

      if (!requestId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing requestId' }));
        return;
      }

      const entry = pending.get(requestId);
      if (!entry) {
        console.log(
          `${ts()} [RESULT] ⚠️  requestId=${requestId} not found (expired or already completed)`
        );
        res.writeHead(404);
        res.end(
          JSON.stringify({ error: 'Request not found or already completed' })
        );
        return;
      }

      if (error) {
        console.log(`${ts()} [RESULT] ❌ requestId=${requestId} error=${error}`);
        entry.reject(new Error(error));
      } else {
        console.log(
          `${ts()} [RESULT] ✅ requestId=${requestId} text=${(text || '').length} chars`
        );
        console.log(
          `${ts()} [RESULT] preview: ${(text || '').slice(0, 300)}`
        );
        entry.resolve({ requestId, text });
      }

      res.writeHead(200);
      res.end(JSON.stringify({ received: true, requestId }));
      return;
    }

    // ── Legacy endpoints (backward compat) ──
    if (
      method === 'POST' &&
      (url === '/api/gemini/request' || url === '/api/gemini/response')
    ) {
      const body = await readBody(req);
      console.log(`${ts()} [LEGACY] ${url} ${body.length} chars`);
      res.writeHead(200);
      res.end(JSON.stringify({ received: true }));
      return;
    }

    // ── 404 ──
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found', path: url }));
  } catch (err) {
    console.error(`${ts()} [ERROR] ${method} ${url} — ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n🌉 Gemini Bridge Server v2.0`);
  console.log(`   http://localhost:${PORT}`);
  console.log(``);
  console.log(`   POST /api/bridge/completions   ← Pi provider sends piRequest (long-poll)`);
  console.log(`   GET  /api/bridge/pending        ← Extension polls for pending prompts`);
  console.log(`   POST /api/bridge/result          ← Extension returns Gemini response`);
  console.log(`   GET  /health                    ← Health check`);
  console.log(``);
  console.log(`   Timeout: ${TIMEOUT_MS / 1000}s | Poll hint: ${POLL_INTERVAL_HINT}ms`);
  console.log(`   Press Ctrl+C to stop\n`);
});

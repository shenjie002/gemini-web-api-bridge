/**
 * Gemini Direct API Bridge Server
 *
 * Architecture: Extension syncs cookies → Server calls Gemini API directly → Returns OpenAI-compatible response
 * No DOM scraping. No page injection. Direct API calls with browser session cookies.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ── Proxy Support ───────────────────────────────────────────────────
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || '';

// ── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3456', 10);
const LOG_DIR = path.join(__dirname, 'logs');
const GEMINI_ORIGIN = 'https://gemini.google.com';

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── State ───────────────────────────────────────────────────────────
let geminiCookies = '';        // Raw cookie string synced from extension
let geminiCookiesHash = '';    // Hash of cookies for change detection (order-insensitive)
let lastCookieSync = 0;        // Timestamp of last cookie sync

// Conversation state: Pi conversationId → { cid, rid, choiceId }
// Allows multi-turn within the same Gemini conversation
const conversations = new Map();

// Session params extracted from Gemini page
let sessionParams = {
  atToken: '',       // SNlM0e — CSRF token
  bl: '',            // Build label for the API URL
  fsid: '',          // f.sid session ID
  cfb2h: '',         // cfb2h token (the long ! prefixed token)
};
let lastSessionRefresh = 0;    // Timestamp of last successful session refresh
const SESSION_TTL = 10 * 60 * 1000; // 10 minutes — session params stay valid this long

/**
 * Order-insensitive hash of cookie string.
 * Cookies may arrive in different order from the extension each time.
 */
function hashCookies(cookieStr) {
  if (!cookieStr) return '';
  const sorted = cookieStr.split(';').map(s => s.trim()).filter(Boolean).sort().join('; ');
  return crypto.createHash('md5').update(sorted).digest('hex');
}

// ── Raw capture control ─────────────────────────────────────────────
const CAPTURE_RAW = process.env.BRIDGE_CAPTURE_RAW === '1';

// ── Logging ─────────────────────────────────────────────────────────
function getLogFile(prefix) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${prefix}-${date}.log`);
}

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  try { fs.appendFileSync(getLogFile('bridge'), line + '\n'); } catch {}
  console.log(line);
}

function logRaw(label, data, { truncate = true } = {}) {
  if (!CAPTURE_RAW) return;
  let content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (truncate && content.length > 3000) {
    content = content.slice(0, 3000) + `\n... [truncated, total ${content.length} chars]`;
  }
  const line = `\n=== ${label} @ ${new Date().toISOString()} ===\n${content}\n`;
  try { fs.appendFileSync(getLogFile('bridge-raw'), line); } catch {}
}

// ── HTTPS Request Helper ────────────────────────────────────────────
/**
 * Make HTTPS requests using Node's native https module.
 * Node's built-in fetch (undici) crashes on Google's huge response headers.
 */
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    let req;
    const handleResponse = (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return httpsRequest(redirectUrl, options).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          text: () => Promise.resolve(body),
          body,
        });
      });
      res.on('error', reject);
    };

    if (PROXY_URL) {
      // HTTP CONNECT tunnel through proxy
      const proxy = new URL(PROXY_URL);
      const connectReq = http.request({
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: `${parsed.hostname}:443`,
        headers: { 'Host': `${parsed.hostname}:443` },
      });

      connectReq.on('connect', (proxyRes, socket) => {
        if (proxyRes.statusCode !== 200) {
          socket.destroy();
          return reject(new Error(`Proxy CONNECT failed: ${proxyRes.statusCode}`));
        }
        req = https.request({
          socket,
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: options.method || 'GET',
          headers: options.headers || {},
          maxHeaderSize: 256 * 1024,
        }, handleResponse);

        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(new Error('Request timeout')); });
        if (options.body) req.write(options.body);
        req.end();
      });

      connectReq.on('error', reject);
      connectReq.setTimeout(15000, () => { connectReq.destroy(new Error('Proxy connect timeout')); });
      connectReq.end();
    } else {
      // Direct connection (no proxy)
      req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        maxHeaderSize: 256 * 1024,
      }, handleResponse);

      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(new Error('Request timeout')); });
      if (options.body) req.write(options.body);
      req.end();
    }
  });
}


// ── Gemini Session Extraction ───────────────────────────────────────

/**
 * Fetch the Gemini page and extract all session parameters needed for API calls.
 */
async function refreshSession() {
  if (!geminiCookies) {
    throw new Error('No cookies available. Please sync cookies from the extension.');
  }

  log({ stage: 'session_refresh', status: 'starting' });

  const resp = await httpsRequest(`${GEMINI_ORIGIN}/app`, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      'Cookie': geminiCookies,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch Gemini page: ${resp.status} ${resp.statusText}`);
  }

  const html = resp.body;
  log({ stage: 'session_refresh', pageSize: html.length });
  logRaw('gemini_page_meta', `Status: ${resp.status}, Length: ${html.length}`, { truncate: false });

  // ── Extract SNlM0e (at token) ──
  const atMatch = html.match(/"SNlM0e":"([^"]+)"/) ||
                  html.match(/WIZ_global_data\s*=\s*\{[\s\S]*?"SNlM0e"\s*:\s*"([^"]+)"/);
  if (atMatch) {
    sessionParams.atToken = atMatch[1];
    log({ stage: 'session_extract', param: 'atToken', preview: sessionParams.atToken.slice(0, 30) + '...' });
  } else {
    throw new Error('Cannot extract SNlM0e token from Gemini page');
  }

  // ── Extract bl (build label) ──
  // Look for: "cfb2h":"boq_assistant-bard-web-server_..."
  // Or in script src URLs containing the build label
  const blMatch = html.match(/"cfb2h":"(boq_assistant-bard-web-server_[^"]+)"/) ||
                  html.match(/bl=(boq_assistant-bard-web-server_[^&"]+)/) ||
                  html.match(/"boq_assistant-bard-web-server_([^"]+)"/);
  if (blMatch) {
    sessionParams.bl = blMatch[1];
    log({ stage: 'session_extract', param: 'bl', value: sessionParams.bl });
  } else {
    // Fallback: try to find any boq_ reference
    const boqMatch = html.match(/boq_assistant-bard-web[^"'\s&]+/);
    if (boqMatch) {
      sessionParams.bl = boqMatch[0];
      log({ stage: 'session_extract', param: 'bl', value: sessionParams.bl, source: 'fallback' });
    } else {
      log({ stage: 'session_extract', param: 'bl', error: 'not found, using default' });
      sessionParams.bl = 'boq_assistant-bard-web-server_20260907.07_p0';
    }
  }

  // ── Extract f.sid ──
  const fsidMatch = html.match(/"FdrFJe":"(\d+)"/) ||
                    html.match(/f\.sid['"]\s*[:=]\s*['"](\d+)['"]/) ||
                    html.match(/"(\d{15,25})"/);  // session IDs are long numeric strings
  if (fsidMatch) {
    sessionParams.fsid = fsidMatch[1];
    log({ stage: 'session_extract', param: 'fsid', value: sessionParams.fsid });
  } else {
    log({ stage: 'session_extract', param: 'fsid', error: 'not found' });
  }

  // ── Extract cfb2h / the long session token (inner[3]) ──
  // This is the tricky one — it's a long base64-ish token starting with !
  // It may be embedded in WIZ_global_data or in a script block
  const cfb2hMatch = html.match(/"cfb2h":"([^"]{50,})"/) ;
  if (cfb2hMatch) {
    sessionParams.cfb2h = cfb2hMatch[1];
    log({ stage: 'session_extract', param: 'cfb2h', length: sessionParams.cfb2h.length });
  }

  lastSessionRefresh = Date.now();

  log({
    stage: 'session_refresh',
    status: 'done',
    hasAtToken: !!sessionParams.atToken,
    hasBl: !!sessionParams.bl,
    hasFsid: !!sessionParams.fsid,
    hasCfb2h: !!sessionParams.cfb2h,
  });
}

// ── Gemini API Client ───────────────────────────────────────────────

/**
 * Build the f.req payload matching Gemini's real request format.
 */
function buildFreq(prompt, convContext) {
  // Build a 99-element inner array matching the real request structure
  const inner = new Array(99).fill(null);

  // [0] — prompt: [text, 0, null, null, null, null, 0]
  inner[0] = [prompt, 0, null, null, null, null, 0];

  // [1] — language
  inner[1] = ["en"];

  // [2] — conversation context: 10-element array
  // New conversation: ["", "", "", null, null, null, null, null, null, ""]
  // Continuation: ["c_xxx", "r_xxx", "rc_xxx", null, null, null, null, null, null, "continuation_token"]
  if (convContext && convContext.cid) {
    inner[2] = [
      convContext.cid,
      convContext.rid,
      convContext.choiceId || '',
      null, null, null, null, null, null,
      convContext.continuationToken || ''
    ];
  } else {
    inner[2] = ['', '', '', null, null, null, null, null, null, ''];
  }

  // [3] — cfb2h session token (the long ! prefixed token)
  inner[3] = sessionParams.cfb2h || null;

  // [4] — hash (can be null for new conversation)
  inner[4] = null;

  // Standard flags observed in real requests
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[1]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[67] = 0;
  inner[68] = 2;
  inner[79] = 6;
  inner[80] = 1;
  inner[91] = 0;
  inner[96] = 0;
  inner[98] = 1;

  const outer = [null, JSON.stringify(inner)];
  return `f.req=${encodeURIComponent(JSON.stringify(outer))}&at=${encodeURIComponent(sessionParams.atToken)}`;
}

/**
 * Call the real Gemini StreamGenerate endpoint.
 */
async function callGeminiAPI(prompt, convContext) {
  if (!geminiCookies) {
    throw new Error('No cookies synced from extension.');
  }

  // Ensure we have valid session params (refresh if expired or missing)
  const sessionAge = Date.now() - lastSessionRefresh;
  if (!sessionParams.atToken || sessionAge > SESSION_TTL) {
    await refreshSession();
  }

  const reqBody = buildFreq(prompt, convContext);
  const reqid = Math.floor(Math.random() * 900000) + 100000;

  let urlPath = `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
  urlPath += `?bl=${encodeURIComponent(sessionParams.bl)}`;
  if (sessionParams.fsid) {
    urlPath += `&f.sid=${encodeURIComponent(sessionParams.fsid)}`;
  }
  urlPath += `&hl=en&_reqid=${reqid}&rt=c`;

  const fullUrl = `${GEMINI_ORIGIN}${urlPath}`;

  if (prompt.length > 20000) {
    log({ stage: 'gemini_api_call', promptLength: prompt.length, url: urlPath.slice(0, 120), warning: 'prompt_very_long' });
  } else {
    log({ stage: 'gemini_api_call', promptLength: prompt.length, url: urlPath.slice(0, 120) });
  }
  logRaw('gemini_request', `URL: ${fullUrl}\nBody length: ${reqBody.length}\nBody preview: ${reqBody.slice(0, 500)}`);

  const resp = await httpsRequest(fullUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': geminiCookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      'Origin': GEMINI_ORIGIN,
      'Referer': `${GEMINI_ORIGIN}/`,
      'X-Same-Domain': '1',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: reqBody,
  });

  logRaw('gemini_response', `Status: ${resp.status}\nBody length: ${resp.body.length}\nBody:\n${resp.body}`, { truncate: false });

  if (!resp.ok) {
    // Auth failure — clear session and let caller retry
    if (resp.status === 401 || resp.status === 403) {
      sessionParams.atToken = '';
      throw new Error(`Auth error (${resp.status}). Cookies may be expired.`);
    }
    throw new Error(`Gemini API error: ${resp.status} ${resp.statusText}`);
  }

  return parseGeminiResponse(resp.body); // Returns { text, truncated, geminiError }
}


// ── Response Parser ─────────────────────────────────────────────────

/**
 * Parse Gemini's StreamGenerate response.
 * Format: )]}'\n followed by lines of: number\n[[json_data]]
 * Detects streaming status and BardErrorInfo errors.
 */
function parseGeminiResponse(raw) {
  log({ stage: 'parse_response', rawLength: raw.length });

  // Strip anti-XSSI prefix
  let cleaned = raw;
  if (cleaned.startsWith(")]}'" + '\n') || cleaned.startsWith(")]}'")) {
    const nlIndex = cleaned.indexOf('\n');
    cleaned = nlIndex > 0 ? cleaned.slice(nlIndex + 1) : cleaned.slice(4);
  }

  const allTexts = [];
  let streamComplete = false;
  let geminiError = null;
  let conversationId = null;  // c_xxx
  let responseId = null;      // r_xxx
  let choiceId = null;        // rc_xxx
  let continuationToken = null; // "26": "AwAAA..." from metadata chunks

  const lines = cleaned.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    i++;

    if (!line || /^\d+$/.test(line)) continue;

    try {
      const parsed = JSON.parse(line);

      // Check for error chunks
      const errInfo = detectBardError(parsed);
      if (errInfo) {
        geminiError = errInfo;
        continue;
      }

      // Also extract metadata from non-text chunks (continuation token, etc.)
      const meta = extractMetadata(parsed);
      if (meta.continuationToken) continuationToken = meta.continuationToken;
      if (meta.cid) conversationId = meta.cid;
      if (meta.rid) responseId = meta.rid;

      const result = extractResponseTextWithStatus(parsed);
      if (result) {
        allTexts.push(result.text);
        if (result.status === 2) streamComplete = true;
        // Capture conversation IDs from the latest chunk
        if (result.cid) conversationId = result.cid;
        if (result.rid) responseId = result.rid;
        if (result.choiceId) choiceId = result.choiceId;
      }
    } catch {}
  }

  const convInfo = { cid: conversationId, rid: responseId, choiceId, continuationToken };

  if (allTexts.length > 0) {
    // Gemini streams cumulative text — each chunk contains everything so far.
    // Normally the last chunk is the full response. But if Gemini's server hits
    // an error mid-stream (e.g. token limit while writing a long tool call), it
    // replaces the final chunk with a short error message like
    // "I encountered an error doing what you asked. Could you try again?"
    // In that case the longest earlier chunk still holds the real content.
    const lastText = allTexts[allTexts.length - 1];
    let longestIdx = 0;
    for (let k = 1; k < allTexts.length; k++) {
      if (allTexts[k].length > allTexts[longestIdx].length) longestIdx = k;
    }
    const longestText = allTexts[longestIdx];

    // Detect the specific server-side error replacement pattern.
    const errorPhrase = /I encountered an error doing what you asked/i;
    const lastIsErrorReplacement =
      longestText.length > lastText.length * 2 && errorPhrase.test(lastText);

    let result;
    let serverErrorDetected = false;
    if (lastIsErrorReplacement) {
      // Server aborted mid-stream: keep the longest partial content, mark truncated.
      result = longestText;
      serverErrorDetected = true;
    } else if (errorPhrase.test(lastText) && allTexts.length === 1) {
      // Only got the error message — nothing salvageable.
      result = lastText;
      serverErrorDetected = true;
    } else {
      // Normal case: last chunk is the final cumulative text.
      result = lastText;
    }

    const truncated = !streamComplete || !!geminiError || serverErrorDetected;
    if (serverErrorDetected && !geminiError) {
      geminiError = { code: 'gemini_stream_aborted', message: 'Gemini replaced stream with error message' };
    }

    log({
      stage: truncated ? 'parse_truncated' : 'parse_success',
      textCount: allTexts.length,
      resultLength: result.length,
      lastTextLength: lastText.length,
      longestTextLength: longestText.length,
      serverErrorDetected,
      streamComplete,
      geminiError: geminiError || undefined,
      conversationId,
      responseId,
      preview: result.slice(0, 200),
    });
    return { text: result, truncated, geminiError: geminiError || null, ...convInfo };
  }

  // Fallback: try to find any reasonable text in the raw response
  const fallback = findResponseTextBruteForce(cleaned);
  if (fallback) {
    log({ stage: 'parse_fallback_success', resultLength: fallback.length });
    return { text: fallback, truncated: true, geminiError: geminiError || null, ...convInfo };
  }

  if (geminiError) {
    log({ stage: 'parse_failed', geminiError });
    throw new Error(`Gemini error: ${geminiError}`);
  }

  log({ stage: 'parse_failed', rawPreview: cleaned.slice(0, 500) });
  throw new Error('Could not parse response text from Gemini API');
}

/**
 * Extract metadata from response chunks.
 * Looks for continuation token {"26": "AwAAA..."}, conversation IDs, etc.
 */
function extractMetadata(data) {
  const meta = {};
  if (!Array.isArray(data)) return meta;
  try {
    for (const item of data) {
      if (!Array.isArray(item)) continue;
      const payload = item[2];
      if (typeof payload === 'string' && payload.length > 5) {
        try {
          const inner = JSON.parse(payload);
          // inner[1] = ["c_xxx", "r_xxx"]
          if (Array.isArray(inner?.[1])) {
            const ids = inner[1];
            if (typeof ids[0] === 'string' && ids[0].startsWith('c_')) meta.cid = ids[0];
            if (typeof ids[1] === 'string' && ids[1].startsWith('r_')) meta.rid = ids[1];
          }
          // inner[2] may be an object with metadata
          const obj = inner?.[2];
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            // {"26": "AwAAA..."} — continuation token
            if (typeof obj['26'] === 'string') meta.continuationToken = obj['26'];
          }
        } catch {}
      }
    }
  } catch {}
  return meta;
}

function detectBardError(data) {
  if (!Array.isArray(data)) return null;
  try {
    for (const item of data) {
      if (!Array.isArray(item)) continue;
      const errBlock = item[5];
      if (!Array.isArray(errBlock)) continue;
      const details = errBlock[2];
      if (!Array.isArray(details)) continue;
      for (const d of details) {
        if (Array.isArray(d) && typeof d[0] === 'string' && d[0].includes('BardErrorInfo')) {
          const code = Array.isArray(d[1]) ? d[1][0] : d[1];
          return `BardErrorInfo code ${code}`;
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Extract response text and stream status from a parsed JSON chunk.
 * Returns { text, status } where status: 1=streaming, 2=complete, or null.
 */
function extractResponseTextWithStatus(data) {
  if (!Array.isArray(data)) return null;

  try {
    if (data[0] && Array.isArray(data[0])) {
      for (const item of data) {
        if (!Array.isArray(item)) continue;

        const payload = item[2];
        if (typeof payload === 'string' && payload.length > 20) {
          try {
            const inner = JSON.parse(payload);
            const text = extractTextFromInner(inner);
            if (text) {
              // Stream status at inner[4][0][8] — [1]=streaming, [2]=complete
              let status = null;
              try {
                const statusArr = inner?.[4]?.[0]?.[8];
                if (Array.isArray(statusArr)) status = statusArr[0];
              } catch {}

              // Extract conversation IDs: inner[1] = ["c_xxx", "r_xxx"]
              let cid = null, rid = null, choiceId = null;
              try {
                const ids = inner?.[1];
                if (Array.isArray(ids)) {
                  if (typeof ids[0] === 'string' && ids[0].startsWith('c_')) cid = ids[0];
                  if (typeof ids[1] === 'string' && ids[1].startsWith('r_')) rid = ids[1];
                }
                // choiceId at inner[4][0][0] — "rc_xxx"
                const rc = inner?.[4]?.[0]?.[0];
                if (typeof rc === 'string' && rc.startsWith('rc_')) choiceId = rc;
              } catch {}

              return { text, status, cid, rid, choiceId };
            }
          } catch {}
        }
      }
    }
  } catch {}

  return null;
}

function extractTextFromInner(data) {
  if (!Array.isArray(data)) return null;

  // Try known paths where Gemini puts the response text
  const paths = [
    [4, 0, 1, 0],      // Common: response text
    [4, 0, 0, 0],      // Alt
    [0, 0],             // Simple
    [0, 0, 0],          // Another
    [3, 0, 0],          // Yet another
    [17, 0, 1, 0],     // Sometimes here
    [4, 0, 1, 0, 0],   // Deeper
    [0, 4, 0, 1, 0],   // With wrapper
  ];

  for (const p of paths) {
    try {
      let val = data;
      for (const idx of p) {
        if (val == null || !Array.isArray(val)) { val = null; break; }
        val = val[idx];
      }
      if (typeof val === 'string' && val.length > 5) {
        return val;
      }
    } catch {}
  }

  return null;
}

/**
 * Walk through nested arrays and find the longest string (likely the response).
 */
function findLongestString(data, maxDepth = 10) {
  if (maxDepth <= 0) return null;

  let longest = '';

  function walk(item, depth) {
    if (depth <= 0) return;
    if (typeof item === 'string' && item.length > longest.length) {
      // Skip strings that look like IDs, tokens, URLs, pure numbers, etc.
      if (!item.startsWith('http') && !item.startsWith('!') &&
          !item.match(/^[a-f0-9-]{20,}$/) && !item.match(/^[A-Za-z0-9_-]{100,}$/) &&
          !item.match(/^\d+$/)) {
        longest = item;
      }
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        walk(child, depth - 1);
      }
    }
  }

  walk(data, maxDepth);
  return longest.length > 5 ? longest : null;
}

/**
 * Brute force: scan the raw text for the response content.
 */
function findResponseTextBruteForce(raw) {
  // Try to find JSON strings in the raw text that look like response text
  const matches = [];
  const regex = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const str = match[1];
    // Look for strings that are likely natural language (not IDs or tokens)
    if (str.length > 20 && str.length < 100000 &&
        !str.startsWith('http') && !str.startsWith('!') &&
        !str.match(/^[a-f0-9_-]+$/) &&
        (str.includes(' ') || str.includes('\n'))) {
      matches.push(str);
    }
  }

  if (matches.length > 0) {
    // Return the longest match (likely the full response)
    matches.sort((a, b) => b.length - a.length);
    // Unescape JSON string escapes
    try {
      return JSON.parse(`"${matches[0]}"`);
    } catch {
      return matches[0];
    }
  }

  return null;
}


// ── HTTP Server ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // ── Health check ──
    if (pathname === '/health' && req.method === 'GET') {
      return json(res, {
        status: 'ok',
        hasCookies: !!geminiCookies,
        hasSession: !!sessionParams.atToken,
        lastCookieSync: lastCookieSync ? new Date(lastCookieSync).toISOString() : null,
        bl: sessionParams.bl || null,
      });
    }

    // ── Cookie sync from extension ──
    if (pathname === '/api/cookies' && req.method === 'POST') {
      const body = await readBody(req);
      const data = JSON.parse(body);

      if (data.cookies) {
        let newCookies;
        if (typeof data.cookies === 'string') {
          newCookies = data.cookies;
        } else if (Array.isArray(data.cookies)) {
          newCookies = data.cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }

        const newHash = hashCookies(newCookies);
        const cookiesChanged = newCookies && newHash !== geminiCookiesHash;
        if (newCookies) {
          geminiCookies = newCookies;
          geminiCookiesHash = newHash;
        }
        lastCookieSync = Date.now();

        // Log whether cookies changed, but never reset session mid-flight.
        // Session will be refreshed naturally when TTL expires or API call fails.
        if (cookiesChanged) {
          lastSessionRefresh = 0; // Mark session as stale, but don't clear params
          log({ stage: 'cookies_synced', cookieLength: geminiCookies.length, cookiesChanged: true });
        } else {
          log({ stage: 'cookies_synced', cookieLength: geminiCookies.length, cookiesChanged: false });
        }
        return json(res, { ok: true, cookieLength: geminiCookies.length });
      }
      return json(res, { error: 'Missing cookies field' }, 400);
    }

    // ── Cookie status ──
    if (pathname === '/api/cookies/status' && req.method === 'GET') {
      return json(res, {
        hasCookies: !!geminiCookies,
        hasAtToken: !!sessionParams.atToken,
        lastSync: lastCookieSync ? new Date(lastCookieSync).toISOString() : null,
        cookieAge: lastCookieSync ? Date.now() - lastCookieSync : null,
      });
    }

    // ── Refresh session manually ──
    if (pathname === '/api/session/refresh' && req.method === 'POST') {
      await refreshSession();
      return json(res, {
        ok: true,
        hasAtToken: !!sessionParams.atToken,
        bl: sessionParams.bl,
        hasFsid: !!sessionParams.fsid,
      });
    }

    // ── Main completion endpoint (Pi Agent calls this) ──
    if (pathname === '/api/bridge/completions' && req.method === 'POST') {
      return await handleCompletion(req, res);
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err) {
    log({ stage: 'server_error', error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

/**
 * Handle completion request from Pi Agent.
 */
async function handleCompletion(req, res) {
  const body = await readBody(req);
  const data = JSON.parse(body);

  const requestId = data.requestId || crypto.randomUUID();
  const prompt = data.prompt || data.messages?.[data.messages.length - 1]?.content || '';
  const conversationId = data.conversationId || null; // Pi session → Gemini conversation

  if (!prompt) {
    return json(res, { error: 'No prompt provided' }, 400);
  }

  log({ stage: 'completion_request', requestId, promptLength: prompt.length, conversationId: conversationId || 'new' });

  if (!geminiCookies) {
    return json(res, {
      error: 'No cookies available. Sync from extension first.',
      requestId,
    }, 503);
  }

  // Look up existing Gemini conversation context
  const convContext = conversationId ? conversations.get(conversationId) || null : null;

  try {
    let result;
    try {
      result = await callGeminiAPI(prompt, convContext);
    } catch (firstErr) {
      log({ stage: 'completion_first_attempt_failed', error: firstErr.message });

      // If session was cleared, refresh and retry once
      if (!sessionParams.atToken) {
        await refreshSession();
        result = await callGeminiAPI(prompt, convContext);
      } else {
        throw firstErr;
      }
    }

    // Update conversation map with new cid/rid from response.
    // IMPORTANT: only persist when the response is complete AND we got a
    // continuation token. A truncated first-turn response (e.g. Gemini
    // returned BardErrorInfo 1155 with a partial cid/rid) means the
    // conversation was never actually established on Gemini's side; if
    // we persist that cid/rid, every follow-up request will try to
    // continue a non-existent session and get BardErrorInfo 1097.
    if (conversationId && result.cid && !result.truncated && !result.geminiError && result.continuationToken) {
      conversations.set(conversationId, {
        cid: result.cid,
        rid: result.rid,
        choiceId: result.choiceId,
        continuationToken: result.continuationToken,
      });
      log({ stage: 'conversation_updated', conversationId, cid: result.cid, rid: result.rid, hasContinuationToken: true });
    } else if (conversationId && (result.truncated || result.geminiError)) {
      // Drop any stale entry so the next request starts a fresh conversation.
      conversations.delete(conversationId);
      log({ stage: 'conversation_dropped', conversationId, reason: result.geminiError || 'truncated' });
    }

    log({
      stage: 'completion_success',
      requestId,
      responseLength: result.text?.length || 0,
      truncated: result.truncated || false,
      geminiError: result.geminiError || undefined,
    });

    const response = { requestId, text: result.text };
    if (result.cid) response.conversationId = result.cid;
    if (result.truncated) {
      response.truncated = true;
      if (result.geminiError) response.geminiError = result.geminiError;
    }
    return json(res, response);

  } catch (err) {
    log({ stage: 'completion_error', requestId, error: err.message });
    return json(res, { requestId, error: err.message }, 502);
  }
}

// ── HTTP Helpers ────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🌉 Gemini Direct API Bridge Server`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   Cookies: ${geminiCookies ? 'loaded' : 'waiting for sync from extension'}`);
  console.log(`   Proxy: ${PROXY_URL || 'none (direct)'}`);
  console.log(`   Raw capture: ${CAPTURE_RAW ? 'ON (BRIDGE_CAPTURE_RAW=1)' : 'OFF'}`);
  console.log(`   Logs: ${LOG_DIR}\n`);
  console.log(`   Endpoints:`);
  console.log(`     POST /api/cookies           — Extension syncs cookies here`);
  console.log(`     GET  /api/cookies/status     — Check cookie status`);
  console.log(`     POST /api/session/refresh    — Force refresh session params`);
  console.log(`     POST /api/bridge/completions — Pi Agent completion requests`);
  console.log(`     GET  /health                — Health check\n`);
});

/**
 * Content Script — runs in MAIN world on gemini.google.com
 *
 * Two modes:
 * 1. Passive interception: captures fetch/XHR to Gemini API endpoints (existing)
 * 2. Active injection: receives prompts from bridge, injects into Gemini,
 *    captures response, and sends it back (new bidirectional bridge)
 *
 * Communication:
 *   Outbound (to ISOLATED world):  postMessage { source: '__gemini_bridge__' }
 *   Inbound  (from ISOLATED world): postMessage { source: '__gemini_bridge_cmd__' }
 */
export default defineContentScript({
  matches: ['https://gemini.google.com/*'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const TAG = '[GeminiBridge][MAIN]';
    console.log(`${TAG} Content script injected`);

    // ── Bridge injection state ────────────────────────────────────
    let bridgeResolve: ((text: string) => void) | null = null;
    let bridgeReject: ((err: Error) => void) | null = null;

    // ── Selectors (configurable, try in order) ───────────────────
    const INPUT_SELECTORS = [
      '.ql-editor.textarea[contenteditable="true"]',
      'rich-textarea .ql-editor[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      '.input-area-container div[contenteditable="true"]',
      'div[contenteditable="true"][aria-label]',
      'div[contenteditable="true"]',
    ];

    const SEND_BUTTON_SELECTORS = [
      'button.send-button',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[data-test-id="send-button"]',
      '.input-area-container button.mdc-icon-button',
      '.send-button-container button',
    ];

    // Selectors for response turn containers
    const TURN_SELECTORS = [
      'message-content.model-response-text',
      '.model-response-text',
      '.response-container message-content',
      'model-response message-content',
      '.conversation-container .model-response',
      '[data-message-author-role="model"]',
    ];

    // ── Inbound: listen for commands from ISOLATED world ─────────
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== '__gemini_bridge_cmd__') return;

      const { type, payload } = event.data;
      console.log(`${TAG} Received command: ${type}`);

      if (type === 'INJECT_PROMPT') {
        handleInjectPrompt(payload);
      }
    });

    async function handleInjectPrompt(payload: {
      requestId: string;
      prompt: string;
    }) {
      const { requestId, prompt } = payload;
      console.log(
        `${TAG} INJECT_PROMPT requestId=${requestId} len=${prompt.length}`
      );

      try {
        const responseText = await injectAndCapture(prompt);
        console.log(
          `${TAG} Response captured: ${responseText.length} chars`
        );
        notifyBridge('BRIDGE_RESPONSE', { requestId, text: responseText });
      } catch (err: any) {
        console.error(`${TAG} Injection failed:`, err);
        notifyBridge('BRIDGE_ERROR', {
          requestId,
          error: err.message || String(err),
        });
      }
    }

    // ── Prompt injection + response capture ──────────────────────

    async function injectAndCapture(prompt: string): Promise<string> {
      // 1. Snapshot current turn count
      const turnsBefore = countModelTurns();
      console.log(`${TAG} Turns before injection: ${turnsBefore}`);

      // 2. Wait for page to be ready
      await waitForInput(10000);

      // 3. Fill input
      const input = findElement(INPUT_SELECTORS);
      if (!input) {
        throw new Error(
          `Cannot find Gemini input element. Tried: ${INPUT_SELECTORS.join(', ')}`
        );
      }
      console.log(
        `${TAG} Found input: ${input.tagName}.${input.className.toString().slice(0, 60)}`
      );

      await fillInput(input, prompt);
      await sleep(300);

      // 4. Send
      const sent = await trySend(input);
      if (!sent) {
        throw new Error(
          `Cannot trigger send. Tried buttons: ${SEND_BUTTON_SELECTORS.join(', ')}`
        );
      }
      console.log(`${TAG} Prompt sent, waiting for response...`);

      // 5. Wait for new model turn to appear
      await waitForNewTurn(turnsBefore, 60000);
      console.log(`${TAG} New model turn detected, waiting for completion...`);

      // 6. Wait for response to finish streaming
      const responseText = await waitForStableResponse(120000);
      return responseText;
    }

    // ── DOM Helpers ──────────────────────────────────────────────

    function findElement(selectors: string[]): Element | null {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch {
          // Invalid selector, skip
        }
      }
      return null;
    }

    function countModelTurns(): number {
      for (const sel of TURN_SELECTORS) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) return els.length;
        } catch {
          // skip
        }
      }
      return 0;
    }

    function getLastModelTurnText(): string {
      for (const sel of TURN_SELECTORS) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            const last = els[els.length - 1];
            return (last.textContent || '').trim();
          }
        } catch {
          // skip
        }
      }
      return '';
    }

    async function waitForInput(timeout: number): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (findElement(INPUT_SELECTORS)) return;
        await sleep(500);
      }
      // Don't throw, just warn — input might still work
      console.warn(`${TAG} waitForInput: timed out after ${timeout}ms`);
    }

    async function fillInput(el: Element, text: string): Promise<void> {
      const htmlEl = el as HTMLElement;

      // Focus the input
      htmlEl.focus();
      await sleep(100);

      // Clear existing content
      htmlEl.innerHTML = '';
      htmlEl.textContent = '';

      // Set new content using multiple strategies
      // Strategy 1: Clipboard paste simulation (most reliable for rich editors)
      try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        });
        htmlEl.dispatchEvent(pasteEvent);
        await sleep(100);

        // Check if paste worked
        if ((htmlEl.textContent || '').trim().length > 0) {
          console.log(`${TAG} fillInput: paste strategy worked`);
          return;
        }
      } catch (e) {
        console.log(`${TAG} fillInput: paste strategy failed:`, e);
      }

      // Strategy 2: Direct innerHTML + input event
      htmlEl.innerHTML = `<p>${escapeHtml(text)}</p>`;
      htmlEl.dispatchEvent(new Event('input', { bubbles: true }));
      htmlEl.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(100);

      // Strategy 3: execCommand (deprecated but works in some editors)
      if ((htmlEl.textContent || '').trim().length === 0) {
        try {
          htmlEl.focus();
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, text);
          console.log(`${TAG} fillInput: execCommand strategy used`);
        } catch (e) {
          console.log(`${TAG} fillInput: execCommand failed:`, e);
        }
      }

      console.log(
        `${TAG} fillInput done, textContent length: ${(htmlEl.textContent || '').length}`
      );
    }

    async function trySend(input: Element): Promise<boolean> {
      // Strategy 1: Find and click send button
      for (const sel of SEND_BUTTON_SELECTORS) {
        try {
          const btns = document.querySelectorAll(sel);
          for (const btn of btns) {
            const htmlBtn = btn as HTMLButtonElement;
            if (!htmlBtn.disabled) {
              htmlBtn.click();
              console.log(
                `${TAG} trySend: clicked button matching "${sel}"`
              );
              return true;
            }
          }
        } catch {
          // skip
        }
      }

      // Strategy 2: Find any enabled button near the input area
      const inputArea =
        input.closest('.input-area-container') ||
        input.closest('.input-area') ||
        input.parentElement?.parentElement;
      if (inputArea) {
        const buttons = inputArea.querySelectorAll(
          'button:not([disabled])'
        );
        for (const btn of buttons) {
          // Look for send-like buttons (with SVG icon, no text or short text)
          const text = (btn.textContent || '').trim();
          if (text.length < 5) {
            (btn as HTMLButtonElement).click();
            console.log(`${TAG} trySend: clicked nearby button`);
            return true;
          }
        }
      }

      // Strategy 3: Simulate Enter key
      console.log(`${TAG} trySend: falling back to Enter key`);
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
      await sleep(100);
      input.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
      return true; // We tried
    }

    async function waitForNewTurn(
      previousCount: number,
      timeout: number
    ): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const current = countModelTurns();
        if (current > previousCount) return;
        await sleep(500);
      }
      // Don't throw — the turn might be identifiable another way
      console.warn(`${TAG} waitForNewTurn: timed out, proceeding anyway`);
    }

    async function waitForStableResponse(timeout: number): Promise<string> {
      const start = Date.now();
      let lastText = '';
      let stableCount = 0;
      const STABLE_THRESHOLD = 3; // 3 consecutive checks (~3s) with same text

      while (Date.now() - start < timeout) {
        await sleep(1000);
        const currentText = getLastModelTurnText();

        if (currentText.length === 0) {
          // Response not yet visible, keep waiting
          stableCount = 0;
          continue;
        }

        if (currentText === lastText) {
          stableCount++;
          if (stableCount >= STABLE_THRESHOLD) {
            console.log(`${TAG} Response stable after ${stableCount} checks`);
            return currentText;
          }
        } else {
          lastText = currentText;
          stableCount = 0;
        }
      }

      // Timeout — return whatever we have
      if (lastText.length > 0) {
        console.warn(`${TAG} waitForStableResponse: timed out, returning partial`);
        return lastText;
      }
      throw new Error('Timeout: no response text detected from Gemini');
    }

    function escapeHtml(text: string): string {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '<br>');
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    }

    // ═══════════════════════════════════════════════════════════════
    // Passive Fetch/XHR Interception (existing, preserved)
    // ═══════════════════════════════════════════════════════════════

    const INTERCEPT_PATTERNS = [
      /alkalimakersuite-pa\.clients6\.google\.com/,
      /generativelanguage\.googleapis\.com/,
      /batchexecute/,
      /StreamGenerate/,
      /GenerateContent/,
    ];

    function shouldIntercept(url: string): boolean {
      return INTERCEPT_PATTERNS.some((p) => p.test(url));
    }

    // ── Intercept Fetch ──
    const originalFetch = window.fetch;
    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (!shouldIntercept(url)) {
        return originalFetch.call(this, input, init);
      }

      const requestId = crypto.randomUUID();
      const timestamp = Date.now();

      const capturedRequest: any = {
        requestId,
        timestamp,
        url,
        method: init?.method || 'GET',
        headers: extractHeaders(init?.headers),
        body: null,
      };

      if (init?.body) {
        try {
          if (typeof init.body === 'string') {
            capturedRequest.body = init.body;
          } else if (init.body instanceof ArrayBuffer) {
            capturedRequest.body = new TextDecoder().decode(init.body);
          } else if (init.body instanceof Blob) {
            capturedRequest.body = await init.body.text();
          }
        } catch {
          capturedRequest.body = '[Unable to capture body]';
        }
      }

      notifyBridge('GEMINI_REQUEST_CAPTURED', capturedRequest);

      const response = await originalFetch.call(this, input, init);
      const clonedResponse = response.clone();
      captureResponse(requestId, url, clonedResponse);

      return response;
    };

    // ── Intercept XHR ──
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...args: any[]
    ) {
      (this as any).__bridge_url = url.toString();
      (this as any).__bridge_method = method;
      return originalXHROpen.apply(this, [method, url, ...args] as any);
    };

    XMLHttpRequest.prototype.send = function (body?: any) {
      const url = (this as any).__bridge_url || '';

      if (shouldIntercept(url)) {
        const requestId = crypto.randomUUID();
        (this as any).__bridge_requestId = requestId;

        const capturedRequest: any = {
          requestId,
          timestamp: Date.now(),
          url,
          method: (this as any).__bridge_method || 'GET',
          headers: {},
          body: typeof body === 'string' ? body : null,
        };

        notifyBridge('GEMINI_REQUEST_CAPTURED', capturedRequest);

        this.addEventListener('load', function () {
          const capturedResponse: any = {
            requestId,
            timestamp: Date.now(),
            url,
            status: this.status,
            statusText: this.statusText,
            headers: parseXHRHeaders(this.getAllResponseHeaders()),
            body: this.responseText,
          };
          notifyBridge('GEMINI_RESPONSE_CAPTURED', capturedResponse);
        });
      }

      return originalXHRSend.call(this, body);
    };

    // ── Shared helpers ──

    function extractHeaders(headers?: HeadersInit): Record<string, string> {
      const result: Record<string, string> = {};
      if (!headers) return result;
      if (headers instanceof Headers) {
        headers.forEach((v, k) => (result[k] = v));
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => (result[k] = v));
      } else {
        Object.assign(result, headers);
      }
      return result;
    }

    function parseXHRHeaders(raw: string): Record<string, string> {
      const result: Record<string, string> = {};
      raw.split('\r\n').forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > 0) {
          result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      });
      return result;
    }

    async function captureResponse(
      requestId: string,
      url: string,
      response: Response
    ) {
      try {
        const body = await response.text();
        const capturedResponse: any = {
          requestId,
          timestamp: Date.now(),
          url,
          status: response.status,
          statusText: response.statusText,
          headers: extractHeaders(response.headers),
          body,
        };
        notifyBridge('GEMINI_RESPONSE_CAPTURED', capturedResponse);
      } catch (e) {
        console.error(`${TAG} Failed to capture response:`, e);
      }
    }

    /**
     * Send message to ISOLATED world via postMessage.
     * Uses source '__gemini_bridge__' for outbound messages.
     */
    function notifyBridge(type: string, payload: any) {
      console.log(
        `${TAG} notifyBridge: ${type}${
          payload?.url ? ` url=${payload.url.slice(0, 80)}` : ''
        }${
          payload?.requestId ? ` rid=${payload.requestId.slice(0, 8)}` : ''
        }`
      );
      window.postMessage(
        { source: '__gemini_bridge__', type, payload },
        '*'
      );
    }
  },
});

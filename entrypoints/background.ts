/**
 * Background Service Worker — Bidirectional Bridge
 *
 * Responsibilities:
 * 1. Poll server for pending prompts → dispatch to content script
 * 2. Receive bridge responses from content script → post back to server
 * 3. Manage config, forward passive captures (legacy)
 */
import { storage } from 'wxt/storage';

const TAG = '[GeminiBridge][BG]';
const POLL_INTERVAL = 2000; // ms

export default defineBackground(() => {
  console.log(`${TAG} Background service worker started`);

  // ── Config ─────────────────────────────────────────────────────
  const defaultConfig: BridgeConfig = {
    enabled: false,
    serverUrl: 'http://localhost:3456',
    autoCaptureCookies: true,
  };

  async function getConfig(): Promise<BridgeConfig> {
    const stored = await storage.getItem<BridgeConfig>('local:bridgeConfig');
    return stored ?? defaultConfig;
  }

  async function setConfig(config: Partial<BridgeConfig>): Promise<BridgeConfig> {
    const current = await getConfig();
    const updated = { ...current, ...config };
    await storage.setItem('local:bridgeConfig', updated);
    return updated;
  }

  // ── Message handler from content / popup ────────────────────────
  browser.runtime.onMessage.addListener(
    (message: BridgeMessage, sender, sendResponse) => {
      handleMessage(message, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true; // async
    }
  );

  async function handleMessage(
    message: BridgeMessage,
    _sender: browser.Runtime.MessageSender
  ): Promise<any> {
    switch (message.type) {
      case 'GET_CONFIG':
        return getConfig();

      case 'SET_CONFIG':
        return setConfig(message.payload);

      case 'GEMINI_REQUEST_CAPTURED':
        return forwardLegacy('/api/gemini/request', message.payload);

      case 'GEMINI_RESPONSE_CAPTURED':
        return forwardLegacy('/api/gemini/response', message.payload);

      // Content script finished injecting + capturing response
      case 'BRIDGE_RESPONSE': {
        const { requestId, text } = message.payload as BridgePromptResponse;
        console.log(`${TAG} BRIDGE_RESPONSE rid=${requestId.slice(0, 8)} len=${text.length}`);
        return postResult(requestId, text, null);
      }

      // Content script encountered an error
      case 'BRIDGE_ERROR': {
        const { requestId, error } = message.payload as BridgePromptError;
        console.error(`${TAG} BRIDGE_ERROR rid=${requestId.slice(0, 8)} err=${error}`);
        return postResult(requestId, null, error);
      }

      case 'PING':
        return { status: 'alive' };

      default:
        return { error: 'Unknown message type' };
    }
  }

  // ── Post result back to server ─────────────────────────────────
  async function postResult(
    requestId: string,
    text: string | null,
    error: string | null
  ) {
    const config = await getConfig();
    const body: any = { requestId };
    if (error) body.error = error;
    else body.text = text;

    try {
      const resp = await fetch(`${config.serverUrl}/api/bridge/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await resp.json();
    } catch (err: any) {
      console.error(`${TAG} postResult failed:`, err);
      return { error: err.message };
    }
  }

  // ── Legacy forward (passive capture) ───────────────────────────
  async function forwardLegacy(path: string, payload: any) {
    const config = await getConfig();
    if (!config.enabled) return { skipped: true, reason: 'Bridge is disabled' };

    try {
      const resp = await fetch(`${config.serverUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await resp.json();
    } catch (err: any) {
      console.error(`${TAG} forwardLegacy ${path} failed:`, err);
      return { error: err.message };
    }
  }

  // ── Polling loop: fetch pending prompts from server ────────────
  let polling = false;

  async function pollOnce() {
    const config = await getConfig();
    if (!config.enabled) return;

    try {
      const resp = await fetch(`${config.serverUrl}/api/bridge/pending`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) return;

      const data = await resp.json();
      if (!data.requestId) return; // nothing pending

      console.log(
        `${TAG} Got pending prompt rid=${data.requestId.slice(0, 8)} len=${data.prompt.length}`
      );

      // Find Gemini tab and dispatch to content script
      const dispatched = await dispatchToGeminiTab(data.requestId, data.prompt);
      if (!dispatched) {
        // No Gemini tab found — send error back
        await postResult(
          data.requestId,
          null,
          'No active Gemini tab found. Please open https://gemini.google.com/'
        );
      }
    } catch (err: any) {
      // Server not reachable — silently ignore
      if (!err.message?.includes('Failed to fetch')) {
        console.warn(`${TAG} Poll error:`, err.message);
      }
    }
  }

  async function injectContentScripts(tabId: number): Promise<void> {
    console.log(`${TAG} Injecting content scripts into tab ${tabId}`);
    try {
      // Inject the MAIN world content script first
      await browser.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/content.js'],
        world: 'MAIN' as any,
      });
    } catch (err: any) {
      console.warn(`${TAG} Failed to inject MAIN content script:`, err.message);
    }
    try {
      // Then inject the ISOLATED world relay script
      await browser.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/bridge-relay.js'],
      });
    } catch (err: any) {
      console.warn(`${TAG} Failed to inject relay script:`, err.message);
    }
    // Give scripts a moment to initialize
    await new Promise((r) => setTimeout(r, 500));
  }

  async function dispatchToGeminiTab(
    requestId: string,
    prompt: string
  ): Promise<boolean> {
    const tabs = await browser.tabs.query({
      url: 'https://gemini.google.com/*',
    });

    if (tabs.length === 0) {
      console.warn(`${TAG} No Gemini tabs found`);
      return false;
    }

    // Use the first active Gemini tab
    const tab = tabs.find((t) => t.active) || tabs[0];
    if (!tab.id) return false;

    console.log(`${TAG} Dispatching to tab ${tab.id}: ${tab.url?.slice(0, 60)}`);

    // Try sending message; if it fails, inject scripts and retry once
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await browser.tabs.sendMessage(tab.id, {
          type: 'INJECT_PROMPT',
          payload: { requestId, prompt },
        } as BridgeMessage);
        return true;
      } catch (err: any) {
        if (attempt === 0) {
          console.warn(`${TAG} sendMessage failed (attempt 1), injecting scripts and retrying...`);
          await injectContentScripts(tab.id);
        } else {
          console.error(`${TAG} Failed to send to tab ${tab.id} after re-injection:`, err.message);
          return false;
        }
      }
    }
    return false;
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    console.log(`${TAG} Polling started (interval=${POLL_INTERVAL}ms)`);

    const loop = async () => {
      while (polling) {
        await pollOnce();
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }
    };
    loop();
  }

  function stopPolling() {
    polling = false;
    console.log(`${TAG} Polling stopped`);
  }

  // Start polling on load; will silently skip if disabled or server unreachable
  startPolling();

  // Re-evaluate polling when config changes
  storage.watch<BridgeConfig>('local:bridgeConfig', (newVal) => {
    if (newVal?.enabled) {
      startPolling();
    } else {
      stopPolling();
    }
  });
});

/**
 * Background Service Worker — Cookie Sync Bridge
 *
 * New simplified architecture:
 * 1. Periodically extract Gemini cookies from the browser
 * 2. Sync cookies to the local bridge server
 * 3. Server handles API calls directly (no more DOM injection)
 */
import { storage } from 'wxt/storage';

const TAG = '[GeminiBridge][BG]';
const COOKIE_SYNC_INTERVAL = 30_000; // 30s — cookies don't change often

export default defineBackground(() => {
  console.log(`${TAG} Background service worker started (direct API mode)`);

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

  // ── Message handler from popup ─────────────────────────────────
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

      case 'SYNC_COOKIES_NOW':
        return syncCookies();

      case 'GET_COOKIE_STATUS':
        return getCookieStatus();

      case 'PING':
        return { status: 'alive' };

      default:
        return { error: 'Unknown message type' };
    }
  }

  // ── Cookie Extraction ──────────────────────────────────────────

  async function extractGeminiCookies(): Promise<browser.Cookies.Cookie[]> {
    // Query by URL — this is the most reliable way in Chrome's cookies API
    const cookies = await browser.cookies.getAll({
      url: 'https://gemini.google.com',
    });

    console.log(`${TAG} Extracted ${cookies.length} cookies for gemini.google.com`);

    // If gemini.google.com has few cookies, also grab .google.com domain cookies
    if (cookies.length < 5) {
      const googleCookies = await browser.cookies.getAll({
        url: 'https://www.google.com',
      });
      console.log(`${TAG} Also found ${googleCookies.length} cookies from google.com`);

      // Merge, deduplicate by name
      const seen = new Set(cookies.map(c => c.name));
      for (const c of googleCookies) {
        if (!seen.has(c.name)) {
          cookies.push(c);
          seen.add(c.name);
        }
      }
    }

    console.log(`${TAG} Total cookies to sync: ${cookies.length}`);
    return cookies;
  }

  async function syncCookies(): Promise<{ ok: boolean; cookieCount?: number; error?: string }> {
    const config = await getConfig();
    if (!config.enabled) {
      return { ok: false, error: 'Bridge is disabled' };
    }

    try {
      const cookies = await extractGeminiCookies();

      if (cookies.length === 0) {
        return { ok: false, error: 'No Gemini cookies found. Make sure you are logged in to gemini.google.com' };
      }

      // Send cookies to local server
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      const resp = await fetch(`${config.serverUrl}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: cookieString }),
      });

      const result = await resp.json();

      if (result.ok) {
        console.log(`${TAG} Cookies synced: ${cookies.length} cookies, ${cookieString.length} chars`);
        await storage.setItem('local:lastCookieSync', Date.now());
        return { ok: true, cookieCount: cookies.length };
      } else {
        return { ok: false, error: result.error || 'Server rejected cookies' };
      }

    } catch (err: any) {
      console.error(`${TAG} Cookie sync failed:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  async function getCookieStatus(): Promise<any> {
    const config = await getConfig();
    try {
      const resp = await fetch(`${config.serverUrl}/api/cookies/status`);
      const serverStatus = await resp.json();
      const lastSync = await storage.getItem<number>('local:lastCookieSync');
      const cookies = await extractGeminiCookies();

      return {
        browserCookieCount: cookies.length,
        lastSync: lastSync ? new Date(lastSync).toISOString() : null,
        server: serverStatus,
      };
    } catch (err: any) {
      return {
        browserCookieCount: 0,
        lastSync: null,
        server: { error: err.message },
      };
    }
  }

  // ── Cookie Sync Loop ───────────────────────────────────────────
  let syncing = false;

  async function syncLoop() {
    while (syncing) {
      const config = await getConfig();
      if (config.enabled && config.autoCaptureCookies) {
        await syncCookies();
      }
      await new Promise(r => setTimeout(r, COOKIE_SYNC_INTERVAL));
    }
  }

  function startSync() {
    if (syncing) return;
    syncing = true;
    console.log(`${TAG} Cookie sync started (interval=${COOKIE_SYNC_INTERVAL}ms)`);
    syncLoop();
  }

  function stopSync() {
    syncing = false;
    console.log(`${TAG} Cookie sync stopped`);
  }

  // Start sync on load
  startSync();

  // Re-evaluate when config changes
  storage.watch<BridgeConfig>('local:bridgeConfig', (newVal) => {
    if (newVal?.enabled) {
      startSync();
    } else {
      stopSync();
    }
  });
});

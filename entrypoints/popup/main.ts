import type { BridgeConfig } from '../../utils/types';

const enableToggle = document.getElementById('enableToggle') as HTMLInputElement;
const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
const cookieToggle = document.getElementById('cookieToggle') as HTMLInputElement;
const syncBtn = document.getElementById('syncBtn') as HTMLButtonElement;
const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
const statusBox = document.getElementById('statusBox') as HTMLDivElement;
const cookieInfo = document.getElementById('cookieInfo') as HTMLDivElement;

// Load config on popup open
async function loadConfig() {
  try {
    const config: BridgeConfig = await browser.runtime.sendMessage({ type: 'GET_CONFIG' });
    enableToggle.checked = config.enabled;
    serverUrlInput.value = config.serverUrl;
    cookieToggle.checked = config.autoCaptureCookies;
    updateStatus(config.enabled ? 'enabled' : 'idle');
    refreshCookieStatus();
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// Save config on any change
async function saveConfig() {
  const config: Partial<BridgeConfig> = {
    enabled: enableToggle.checked,
    serverUrl: serverUrlInput.value.trim() || 'http://localhost:3456',
    autoCaptureCookies: cookieToggle.checked,
  };
  try {
    await browser.runtime.sendMessage({ type: 'SET_CONFIG', payload: config });
    updateStatus(config.enabled ? 'enabled' : 'idle');
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// Sync cookies manually
async function syncCookiesNow() {
  syncBtn.textContent = '⏳ Syncing...';
  syncBtn.disabled = true;

  try {
    const result = await browser.runtime.sendMessage({ type: 'SYNC_COOKIES_NOW' });
    if (result.ok) {
      statusBox.textContent = `✅ Cookies synced (${result.cookieCount} cookies)`;
      statusBox.className = 'status connected';
    } else {
      statusBox.textContent = `⚠️ Sync failed: ${result.error}`;
      statusBox.className = 'status warning';
    }
  } catch (err: any) {
    statusBox.textContent = `❌ Sync error: ${err.message}`;
    statusBox.className = 'status disconnected';
  } finally {
    syncBtn.textContent = '🔄 Sync Cookies Now';
    syncBtn.disabled = false;
    refreshCookieStatus();
  }
}

// Refresh cookie status display
async function refreshCookieStatus() {
  try {
    const status = await browser.runtime.sendMessage({ type: 'GET_COOKIE_STATUS' });

    let html = '';
    html += `<span class="label">Browser cookies:</span> <span class="value ${status.browserCookieCount > 0 ? 'ok' : 'missing'}">${status.browserCookieCount} found</span><br>`;

    if (status.server && !status.server.error) {
      html += `<span class="label">Server cookies:</span> <span class="value ${status.server.hasCookies ? 'ok' : 'missing'}">${status.server.hasCookies ? 'loaded' : 'not synced'}</span><br>`;
      html += `<span class="label">API token:</span> <span class="value ${status.server.hasAtToken ? 'ok' : 'missing'}">${status.server.hasAtToken ? 'ready' : 'pending'}</span><br>`;
    } else {
      html += `<span class="label">Server:</span> <span class="value missing">${status.server?.error || 'not reachable'}</span><br>`;
    }

    if (status.lastSync) {
      const ago = Math.round((Date.now() - new Date(status.lastSync).getTime()) / 1000);
      html += `<span class="label">Last sync:</span> <span class="value">${ago}s ago</span>`;
    }

    cookieInfo.innerHTML = html;
  } catch {
    cookieInfo.textContent = 'Unable to fetch status';
  }
}

// Test connection to bridge server
async function testConnection() {
  const url = serverUrlInput.value.trim() || 'http://localhost:3456';
  statusBox.textContent = 'Testing...';
  statusBox.className = 'status idle';
  try {
    const resp = await fetch(`${url}/health`, { method: 'GET' });
    if (resp.ok) {
      const data = await resp.json();
      const parts = [];
      if (data.hasCookies) parts.push('cookies ✓');
      else parts.push('no cookies');
      if (data.hasAtToken) parts.push('token ✓');
      statusBox.textContent = `✅ Connected — ${parts.join(', ')}`;
      statusBox.className = 'status connected';
    } else {
      statusBox.textContent = `⚠️ Server responded: ${resp.status}`;
      statusBox.className = 'status disconnected';
    }
  } catch (err: any) {
    statusBox.textContent = `❌ Connection failed: ${err.message}`;
    statusBox.className = 'status disconnected';
  }
}

function updateStatus(state: 'enabled' | 'idle') {
  if (state === 'enabled') {
    statusBox.textContent = '🟢 Bridge active — direct API mode';
    statusBox.className = 'status connected';
  } else {
    statusBox.textContent = '⏸️ Bridge disabled';
    statusBox.className = 'status idle';
  }
}

// Event listeners
enableToggle.addEventListener('change', saveConfig);
serverUrlInput.addEventListener('change', saveConfig);
cookieToggle.addEventListener('change', saveConfig);
syncBtn.addEventListener('click', syncCookiesNow);
testBtn.addEventListener('click', testConnection);

// Init
loadConfig();

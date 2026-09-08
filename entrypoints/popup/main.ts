import type { BridgeConfig } from '../../utils/types';

const enableToggle = document.getElementById('enableToggle') as HTMLInputElement;
const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
const cookieToggle = document.getElementById('cookieToggle') as HTMLInputElement;
const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
const statusBox = document.getElementById('statusBox') as HTMLDivElement;
const statsDiv = document.getElementById('stats') as HTMLDivElement;

// Load config on popup open
async function loadConfig() {
  try {
    const config: BridgeConfig = await browser.runtime.sendMessage({ type: 'GET_CONFIG' });
    enableToggle.checked = config.enabled;
    serverUrlInput.value = config.serverUrl;
    cookieToggle.checked = config.autoCaptureCookies;
    updateStatus(config.enabled ? 'enabled' : 'idle');
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

// Test connection to bridge server
async function testConnection() {
  const url = serverUrlInput.value.trim() || 'http://localhost:3456';
  statusBox.textContent = 'Testing...';
  statusBox.className = 'status idle';
  try {
    const resp = await fetch(`${url}/health`, { method: 'GET' });
    if (resp.ok) {
      statusBox.textContent = `✅ Connected (${resp.status})`;
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
    statusBox.textContent = '🟢 Bridge active — intercepting Gemini requests';
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
testBtn.addEventListener('click', testConnection);

// Init
loadConfig();

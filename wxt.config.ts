import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Gemini Web API Bridge',
    description: 'Bridge Gemini web requests to an OpenAI-compatible API endpoint',
    version: '0.1.0',
    icons: {
      16: '/icon-16.png',
      32: '/icon-32.png',
      48: '/icon-48.png',
      128: '/icon-128.png',
    },
    permissions: [
      'storage',
      'tabs',
      'scripting',
      'webRequest',
      'declarativeNetRequest',
    ],
    host_permissions: [
      'https://gemini.google.com/*',
      'https://alkalimakersuite-pa.clients6.google.com/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
  },
  runner: {
    startUrls: ['https://gemini.google.com/'],
  },
});

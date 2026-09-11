/** Bridge configuration stored in extension storage */
export interface BridgeConfig {
  enabled: boolean;
  serverUrl: string;
  autoCaptureCookies: boolean;
}

// ── Message Types ──────────────────────────────────────────────────

/** Message types for communication between background and popup */
export type BridgeMessage =
  // Config
  | { type: 'GET_CONFIG'; payload?: undefined }
  | { type: 'SET_CONFIG'; payload: Partial<BridgeConfig> }
  // Cookie management
  | { type: 'SYNC_COOKIES_NOW'; payload?: undefined }
  | { type: 'GET_COOKIE_STATUS'; payload?: undefined }
  // Misc
  | { type: 'PING'; payload?: undefined };

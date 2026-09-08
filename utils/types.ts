/** Bridge configuration stored in extension storage */
export interface BridgeConfig {
  enabled: boolean;
  serverUrl: string;
  autoCaptureCookies: boolean;
}

// ── Bidirectional Bridge Types ─────────────────────────────────────

/** Prompt request dispatched from server → extension → Gemini */
export interface BridgePromptRequest {
  requestId: string;
  prompt: string;
}

/** Successful response from Gemini → extension → server */
export interface BridgePromptResponse {
  requestId: string;
  text: string;
}

/** Error response from Gemini → extension → server */
export interface BridgePromptError {
  requestId: string;
  error: string;
}

// ── Message Types ──────────────────────────────────────────────────

/** Message types for communication between content script, background, and popup */
export type BridgeMessage =
  // Config
  | { type: 'GET_CONFIG'; payload?: undefined }
  | { type: 'SET_CONFIG'; payload: Partial<BridgeConfig> }
  // Passive capture (existing)
  | { type: 'GEMINI_REQUEST_CAPTURED'; payload: CapturedRequest }
  | { type: 'GEMINI_RESPONSE_CAPTURED'; payload: CapturedResponse }
  // Bidirectional bridge (new)
  | { type: 'INJECT_PROMPT'; payload: BridgePromptRequest }
  | { type: 'BRIDGE_RESPONSE'; payload: BridgePromptResponse }
  | { type: 'BRIDGE_ERROR'; payload: BridgePromptError }
  // Misc
  | { type: 'PING'; payload?: undefined };

// ── Captured Request/Response (passive interception) ───────────────

/** Captured outgoing request from Gemini page */
export interface CapturedRequest {
  requestId: string;
  timestamp: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Captured response from Gemini API */
export interface CapturedResponse {
  requestId: string;
  timestamp: number;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
}

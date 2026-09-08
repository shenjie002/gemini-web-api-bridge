/**
 * Bridge Relay Content Script — runs in ISOLATED world
 *
 * Bidirectional relay between:
 *   MAIN world (content.ts)  ↔  background service worker
 *
 * Direction 1 (outbound): MAIN → postMessage → ISOLATED → runtime.sendMessage → BG
 * Direction 2 (inbound):  BG → runtime.onMessage → ISOLATED → postMessage → MAIN
 *
 * postMessage sources:
 *   '__gemini_bridge__'     = outbound from MAIN world
 *   '__gemini_bridge_cmd__' = inbound to MAIN world (commands from BG)
 */
export default defineContentScript({
  matches: ['https://gemini.google.com/*'],
  runAt: 'document_start',
  // Default world is ISOLATED — has access to browser.runtime

  main() {
    const TAG = '[GeminiBridge][ISOLATED]';
    console.log(`${TAG} Bridge relay loaded`);

    // ── Direction 1: MAIN → BG (outbound) ────────────────────────
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== '__gemini_bridge__') return;

      const { type, payload } = event.data;
      if (!type) return;

      console.log(`${TAG} Outbound: ${type}`);

      browser.runtime
        .sendMessage({ type, payload })
        .then((response) => {
          if (response?.error) {
            console.warn(`${TAG} BG error for ${type}:`, response.error);
          }
        })
        .catch((err) => {
          console.error(`${TAG} Failed to send ${type} to BG:`, err);
        });
    });

    // ── Direction 2: BG → MAIN (inbound) ─────────────────────────
    browser.runtime.onMessage.addListener(
      (message: any, _sender, sendResponse) => {
        const { type, payload } = message;
        if (!type) return;

        console.log(`${TAG} Inbound: ${type}`);

        // Forward to MAIN world via postMessage with command source
        window.postMessage(
          { source: '__gemini_bridge_cmd__', type, payload },
          '*'
        );

        sendResponse({ relayed: true });
        return true;
      }
    );
  },
});

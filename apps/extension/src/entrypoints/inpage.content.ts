import { defineContentScript } from "wxt/utils/define-content-script";
import { installProvider } from "../provider/inpage";

/**
 * The page-world provider (EIP-1193 + EIP-6963). Runs in the page's MAIN world at document_start, so dapps find it
 * before their own scripts run. It has no extension privileges: every request goes through the content-script bridge.
 */
export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",
  main() {
    installProvider(window);
  },
});

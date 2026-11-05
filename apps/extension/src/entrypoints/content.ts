import { defineContentScript } from "wxt/utils/define-content-script";
import { startBridge } from "../provider/bridge";

/** ISOLATED-world bridge between the page's provider and the service worker (plan §30 §2.3). */
export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  allFrames: true,
  main() {
    startBridge();
  },
});

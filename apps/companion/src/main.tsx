// First: the navigation guard is in place before any other module (or dependency) runs.
import "./navGuard.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline-first: the service worker serves the app from its cache and never goes to the network for anything
// else (sw.js is generated at build time with the exact asset list and digests). Updates wait for the user
// (ui/update.tsx); `updateViaCache: "none"` makes the browser's update check bypass the HTTP cache for sw.js.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" });
}

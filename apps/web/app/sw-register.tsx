"use client";

import { useEffect } from "react";
import { captureInstallPrompt } from "@/lib/install";

/**
 * Registers the PWA service worker (public/sw.js) in production builds; development stays uncached. The build id in
 * the URL makes each deploy a new worker version, which clears the previous caches when it takes over.
 */
export function RegisterServiceWorker() {
  useEffect(() => captureInstallPrompt(), []);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const v = process.env.NEXT_PUBLIC_QUEUEBIT_BUILD_ID ?? "dev";
    void navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(v)}`, { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}

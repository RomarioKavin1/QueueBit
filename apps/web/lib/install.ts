"use client";

import { useEffect, useState } from "react";

/** Chrome's install prompt (not in the DOM typings). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    __qbInstall?: InstallPromptEvent | null;
  }
}

const DISMISSED = "qb:install-dismissed";

/** Caught as early as possible (the event fires once, soon after load); app/sw-register.tsx calls this. */
export function captureInstallPrompt(): () => void {
  const on = (e: Event) => {
    e.preventDefault();
    window.__qbInstall = e as InstallPromptEvent;
    window.dispatchEvent(new Event("qb:installable"));
  };
  const done = () => {
    window.__qbInstall = null;
    window.dispatchEvent(new Event("qb:installable"));
  };
  window.addEventListener("beforeinstallprompt", on);
  window.addEventListener("appinstalled", done);
  return () => {
    window.removeEventListener("beforeinstallprompt", on);
    window.removeEventListener("appinstalled", done);
  };
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone / iPad Safari: no install prompt, only Share → Add to Home Screen. */
function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/u.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/**
 * Whether to offer "Add QueueBit to your home screen", and how: the browser's own prompt where there is one (Chrome,
 * Edge, Android), else the iOS steps. Hidden once installed, when running installed, or after "Not now".
 */
export function useInstall() {
  const [state, setState] = useState<{ mode: "prompt" | "ios" | null }>({ mode: null });
  useEffect(() => {
    const read = () => {
      if (isStandalone() || localStorage.getItem(DISMISSED)) return setState({ mode: null });
      if (window.__qbInstall) return setState({ mode: "prompt" });
      setState({ mode: isIos() ? "ios" : null });
    };
    read();
    window.addEventListener("qb:installable", read);
    return () => window.removeEventListener("qb:installable", read);
  }, []);
  return {
    mode: state.mode,
    async install() {
      const e = window.__qbInstall;
      if (!e) return;
      await e.prompt();
      const { outcome } = await e.userChoice;
      window.__qbInstall = null;
      if (outcome === "accepted") setState({ mode: null });
    },
    dismiss() {
      localStorage.setItem(DISMISSED, "1");
      setState({ mode: null });
    },
  };
}

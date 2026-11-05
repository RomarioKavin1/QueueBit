import { browser, type Browser } from "wxt/browser";
import type { KV } from "../shared/kv";
import type { ApprovalWindows } from "./approvals";

type StorageArea = Browser.storage.StorageArea;

export function chromeKV(area: StorageArea): KV {
  return {
    async get<T>(key: string) {
      const r = await area.get(key);
      return r[key] as T | undefined;
    },
    async set<T>(key: string, value: T) {
      await area.set({ [key]: value });
    },
    async remove(key: string) {
      await area.remove(key);
    },
  };
}

const APPROVAL_SIZE = { width: 360, height: 600 };

/** Approval windows: 360 × 600 popup windows anchored to the top-right of the current browser window. */
export const chromeApprovalWindows: ApprovalWindows = {
  async open(approvalId) {
    const url = browser.runtime.getURL(`/approve.html?id=${encodeURIComponent(approvalId)}`);
    let position: { left?: number; top?: number } = {};
    try {
      const last = await browser.windows.getLastFocused();
      if (last.left !== undefined && last.width !== undefined && last.top !== undefined) {
        position = { left: Math.max(0, last.left + last.width - APPROVAL_SIZE.width - 16), top: last.top + 72 };
      }
    } catch {
      // No browser window (e.g. headless startup): let Chrome place it.
    }
    const base = { url, type: "popup" as const, focused: true, ...APPROVAL_SIZE };
    try {
      return (await browser.windows.create({ ...base, ...position }))?.id;
    } catch {
      // "Bounds must be at least 50% within visible screen space" (multi-monitor, small screens): let Chrome place it.
      return (await browser.windows.create(base))?.id;
    }
  },
  async focus(windowId) {
    try {
      await browser.windows.update(windowId, { focused: true });
      return true;
    } catch {
      return false;
    }
  },
  async exists(windowId) {
    try {
      await browser.windows.get(windowId);
      return true;
    } catch {
      return false;
    }
  },
};

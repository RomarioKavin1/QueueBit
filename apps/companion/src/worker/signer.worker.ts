/// <reference lib="webworker" />
import { handle } from "./handler.js";
import type { WorkerMessage, WorkerRequest } from "./protocol.js";

// Calls run one at a time: a second sign request waits for the first (the UI never sends two anyway).
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (ev: MessageEvent<{ id: number; req: WorkerRequest }>) => {
  const { id, req } = ev.data;
  const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);
  queue = queue.then(async () => {
    try {
      const result = await handle(req, (phase, fraction) =>
        post({ id, progress: { phase, ...(fraction !== undefined ? { fraction } : {}) } }),
      );
      post({ id, ok: true, result });
    } catch (e) {
      const err = e as Error;
      post({
        id,
        ok: false,
        error: {
          name: err.name,
          message: err.message,
          // RequestRejected and SignRefused carry UI copy (code, title, body).
          ...pick(err as Error & { code?: unknown; title?: unknown; body?: unknown }),
        },
      });
    }
  });
};

function pick(e: { code?: unknown; title?: unknown; body?: unknown }): {
  code?: string;
  title?: string;
  body?: string;
} {
  const out: { code?: string; title?: string; body?: string } = {};
  if (typeof e.code === "string") out.code = e.code;
  if (typeof e.title === "string") out.title = e.title;
  if (typeof e.body === "string") out.body = e.body;
  return out;
}

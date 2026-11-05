/// <reference lib="webworker" />
import { RequestRejected } from "../core/clearsign.js";
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
          ...(err instanceof RequestRejected ? { code: err.code, title: err.title, body: err.body } : {}),
        },
      });
    }
  });
};

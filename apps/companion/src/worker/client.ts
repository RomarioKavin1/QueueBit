import SignerWorker from "./signer.worker.ts?worker&inline";
import type { Phase, WorkerMessage, WorkerRequest, WorkerResult } from "./protocol.js";

/**
 * Promise wrapper over the signing worker. The worker is built inline (a `blob:` URL), so it inherits this page's
 * Content-Security-Policy, including `connect-src 'none'`: the code that touches secrets cannot open a connection.
 */

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly title?: string,
    readonly body?: string,
    name = "WorkerError",
  ) {
    super(message);
    this.name = name;
  }
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (r: WorkerResult) => void; reject: (e: Error) => void; onProgress?: (p: Phase, f?: number) => void }
>();

function get(): Worker {
  if (worker) return worker;
  worker = new SignerWorker();
  worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    if ("progress" in m) {
      p.onProgress?.(m.progress.phase, m.progress.fraction);
      return;
    }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new WorkerError(m.error.message, m.error.code, m.error.title, m.error.body, m.error.name));
  };
  worker.onerror = (ev) => {
    for (const [, p] of pending) p.reject(new WorkerError(ev.message || "The signing worker failed"));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export function call<R extends WorkerResult["op"]>(
  req: WorkerRequest & { op: R },
  onProgress?: (p: Phase, f?: number) => void,
): Promise<Extract<WorkerResult, { op: R }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: WorkerResult) => void, reject, ...(onProgress ? { onProgress } : {}) });
    // Typed arrays are copied (structured clone), not transferred: the caller keeps and wipes its own copy.
    get().postMessage({ id, req });
  });
}

/** Ends the worker (and with it any key material in its memory). */
export function terminate(): void {
  worker?.terminate();
  worker = undefined;
  for (const [, p] of pending) p.reject(new WorkerError("Cancelled"));
  pending.clear();
}

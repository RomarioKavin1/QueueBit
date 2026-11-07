// The PQAggregator's SPHINCS- C13 signing key (@queuebit/pq-signer, WASM). Signing takes seconds (~2.6 s on an
// M3, ~16 s on a 2-core ARM server), so the node signs in a worker thread and its event loop stays responsive.
//
// The secret comes from LEANPOOL_PQ_KEY (hex) or LEANPOOL_PQ_KEY_FILE (a file holding the hex, or a JSON object with
// a `secretKey` field). It is never logged; only the public key is.
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { bytesToHex, hexToBytes, isHex } from "viem";
import type { Hex } from "viem";
import * as c13 from "@queuebit/pq-signer";

export interface C13Signer {
  /** pkSeed(16) ‖ pkRoot(16): what the PQAggregator stores as `publicKey`. */
  publicKey: Hex;
  /** A 3,688-byte C13 signature over a 32-byte digest. */
  sign(digest: Hex): Promise<Hex>;
  close(): Promise<void>;
}

/** Reads the 64-byte C13 secret key (skSeed ‖ pk) from a hex string or a key file. */
export function readSecretKey(o: { key?: string; keyFile?: string }): Uint8Array {
  let raw = o.key;
  if (!raw && o.keyFile) {
    const text = fs.readFileSync(o.keyFile, "utf8").trim();
    raw = text.startsWith("{") ? (JSON.parse(text) as { secretKey?: string }).secretKey : text;
  }
  if (!raw) throw new Error("LEANPOOL_PQ_KEY or LEANPOOL_PQ_KEY_FILE is required with LEANPOOL_PQ_AGGREGATOR");
  if (!isHex(raw) || raw.length !== 2 + 2 * c13.SK_LENGTH) {
    throw new Error(`the C13 secret key must be ${c13.SK_LENGTH} bytes of hex (skSeed ‖ pkSeed ‖ pkRoot)`);
  }
  return hexToBytes(raw);
}

/** Signs in this thread (blocks the event loop for the whole signature): tests and one-off scripts. */
export function inlineSigner(secretKey: Uint8Array): C13Signer {
  const sk = secretKey.slice();
  return {
    publicKey: bytesToHex(c13.publicKeyOf(sk)),
    async sign(digest) {
      return bytesToHex(c13.sign(sk, hexToBytes(digest)));
    },
    async close() {
      sk.fill(0);
    },
  };
}

/** Signs in a worker thread (dist/c13-worker.js), one signature at a time, in request order. */
export function workerSigner(secretKey: Uint8Array): C13Signer {
  const publicKey = bytesToHex(c13.publicKeyOf(secretKey));
  const worker = new Worker(new URL("./c13-worker.js", import.meta.url), { workerData: { secretKey } });
  worker.unref();
  let next = 0;
  const waiting = new Map<number, { resolve: (s: Hex) => void; reject: (e: Error) => void }>();
  worker.on("message", (m: { id: number; sig?: Hex; error?: string }) => {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.sig) w.resolve(m.sig);
    else w.reject(new Error(m.error ?? "C13 signing failed"));
  });
  // A dead worker fails every pending and later signature (the node logs it; restart the node).
  let dead: Error | null = null;
  const fail = (e: Error) => {
    dead ??= e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`the C13 signing worker exited (${code})`)));
  return {
    publicKey,
    sign(digest) {
      const id = next++;
      if (dead) return Promise.reject(dead);
      return new Promise<Hex>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.ref();
        worker.postMessage({ id, digest });
      }).finally(() => {
        if (waiting.size === 0) worker.unref();
      });
    },
    async close() {
      await worker.terminate();
    },
  };
}

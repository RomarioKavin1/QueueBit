// Worker thread of c13.ts `workerSigner`: holds the C13 secret key and signs digests one at a time.
import { parentPort, workerData } from "node:worker_threads";
import { bytesToHex, hexToBytes } from "viem";
import type { Hex } from "viem";
import * as c13 from "@queuebit/pq-signer";

const sk = (workerData as { secretKey: Uint8Array }).secretKey;

parentPort!.on("message", (m: { id: number; digest: Hex }) => {
  try {
    parentPort!.postMessage({ id: m.id, sig: bytesToHex(c13.sign(sk, hexToBytes(m.digest))) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: (e as Error).message });
  }
});

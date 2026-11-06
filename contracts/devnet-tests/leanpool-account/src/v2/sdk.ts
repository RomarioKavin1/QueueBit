/**
 * LeanPool v2 SDK: sign a frame tx whose VERIFY frame declares one EIP-8288 dependency, and hand it to a node.
 *
 *   const lp = await LeanPoolV2.open({ wallet, node: "http://127.0.0.1:8702" });
 *   const { txHash } = await lp.send({ to, value });   // lane picked from 1..LANES
 *   await lp.waitIncluded(txHash);
 */
import fs from "node:fs";
import type { Address, Hex } from "viem";
import { keyedNonce } from "../core/chain.ts";
import { encodeRaw, sigHash, txHash } from "../core/frameTx.ts";
import type { Call, FrameTx } from "../core/frameTx.ts";
import * as pq from "./leanpq.ts";
import { PQ_V2_KEY } from "./config.ts";
import { buildTx8288 } from "./tx.ts";

export const LANES = 32;

export async function nodeRpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export class LeanPoolV2 {
  private pending = new Map<bigint, { tx: FrameTx; hash: Hex }>();
  /** Every tx this instance sent, by hash: lanes are freed and reused, waiting must still find older txs. */
  private sent = new Map<Hex, FrameTx>();
  private constructor(readonly wallet: Address, readonly key: pq.PqKey, readonly node: string) {}

  static async open(o: { wallet: Address; node: string; keyFile?: string }) {
    const secret = fs.readFileSync(o.keyFile ?? PQ_V2_KEY, "utf8").trim() as Hex;
    return new LeanPoolV2(o.wallet, await pq.keyFromBytes(secret), o.node);
  }

  /** The unsigned-witness tx and its leanSPHINCS signature over SIG_HASH. */
  async sign(call: Call, nonceKey: bigint): Promise<{ tx: FrameTx; sig: Hex }> {
    const tx = buildTx8288({ wallet: this.wallet, vk: this.key.publicKey, nonceKey, nonceSeq: await keyedNonce(this.wallet, nonceKey), call });
    return { tx, sig: await this.key.sign(sigHash(tx)) };
  }

  async send(call: Call, nonceKey?: bigint): Promise<{ txHash: Hex; nonceKey: bigint; tx: FrameTx }> {
    const lane = nonceKey ?? (await this.freeLane());
    const { tx, sig } = await this.sign(call, lane);
    const r = await nodeRpc(this.node, "leanpool_sendTransaction", [{ raw: encodeRaw(tx), sigs: [sig] }]);
    this.pending.set(lane, { tx, hash: r.txHash });
    this.sent.set(r.txHash, tx);
    return { txHash: r.txHash, nonceKey: lane, tx };
  }

  /** A lane with no tx of ours still pending (EIP-8250: one pending tx per (sender, key) in the alt mempool). */
  private async freeLane(): Promise<bigint> {
    for (let k = 1n; k <= BigInt(LANES); k++) {
      const p = this.pending.get(k);
      if (!p || (await keyedNonce(this.wallet, k)) > p.tx.nonceSeq) {
        this.pending.delete(k);
        return k;
      }
    }
    throw new Error(`all ${LANES} lanes have a pending tx`);
  }

  /** Waits until the tx's nonce lane has moved past it, i.e. it (or a replacement) was included. */
  async waitIncluded(hash: Hex, timeoutMs = 240_000) {
    const tx = this.sent.get(hash);
    if (!tx) throw new Error(`unknown tx ${hash}`);
    const entry = { tx };
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if ((await keyedNonce(this.wallet, entry.tx.nonceKeys[0])) > entry.tx.nonceSeq) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`tx ${hash} not included within ${timeoutMs / 1000}s`);
  }
}

export { txHash };

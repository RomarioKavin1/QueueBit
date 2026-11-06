import { encodeTx } from "@queuebit/frames";
import type { LeanPoolClient, SidecarClient } from "@queuebit/rpc";
import type { Hex } from "viem";
import { LEAN_PROFILE, type TxPlan } from "./tx.js";

export type Submission = { via: "leanpool"; poolId: Hex } | { via: "alt-mempool"; txHash: Hex };

/**
 * Sends a signed tx. With a PQ signer it goes to a LeanPool node (it verifies the leanSPHINCS signatures, batches them,
 * posts the root, fills the witness and delivers the tx; follow it with `leanpool.getTx(poolId)`). Without one it goes
 * straight to the ERC-8421 alt mempool through a sidecar: the keystore reads only storage keyed by the account, so the
 * account needs no stake, and the canonical mempool refuses it (StorageReadNonSender).
 */
export async function submit(
  plan: TxPlan,
  to: { leanpool?: LeanPoolClient; sidecar: SidecarClient },
): Promise<Submission> {
  if (plan.pqSigs.length) {
    if (!to.leanpool) throw new Error("a PQ-signed tx needs a LeanPool node");
    const { txHash } = await to.leanpool.sendTransaction(encodeTx(LEAN_PROFILE, plan.tx), plan.pqSigs);
    return { via: "leanpool", poolId: txHash };
  }
  return { via: "alt-mempool", txHash: await to.sidecar.sendFrameTransaction(plan.tx) };
}

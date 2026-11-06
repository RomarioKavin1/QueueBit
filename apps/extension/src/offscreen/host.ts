import { browser } from "wxt/browser";
import {
  createWorkerProver,
  type CommitmentCircuitInputs,
  type PortLike,
  type ProveResult,
  type RagequitProveResult,
  type WithdrawCircuitInputs,
} from "@queuebit/privacy";
import { answerOffscreen, anonStatusFor, isOffscreenRequest, type OffscreenResponse } from "../shared/offscreen";
import ProverWorker from "./prover.worker?worker";

/**
 * The offscreen document (one per extension, plan §30 §2.1): answers the service worker's typed requests
 * (`shared/offscreen.ts`). Proving runs in a dedicated Worker (`prover.worker.ts`, `@queuebit/groth16`), so a 2–3 s
 * proof never blocks this document's message loop. The Worker is created on the first proof and kept: its pinned
 * 17 MB proving key is loaded and hash-checked once.
 */
export function startOffscreen(): void {
  let prover: ReturnType<typeof createWorkerProver> | undefined;
  let provedCount = 0;
  const getProver = () =>
    (prover ??= createWorkerProver(new ProverWorker() as unknown as PortLike, { timeoutMs: 600_000 }));

  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (r: OffscreenResponse) => void) => {
    if (!isOffscreenRequest(msg) || sender.id !== browser.runtime.id) return false;
    void answerOffscreen(msg, {
      ping: async () => ({ prover: prover ? "ready" : "idle", provedCount }),
      prove: async ({ inputs }: { inputs: WithdrawCircuitInputs }): Promise<ProveResult> => {
        const r = await getProver().prove(inputs);
        provedCount++;
        return r;
      },
      "prove-ragequit": async ({ inputs }: { inputs: CommitmentCircuitInputs }): Promise<RagequitProveResult> => {
        const r = await getProver().proveRagequit(inputs);
        provedCount++;
        return r;
      },
      // The Anon-RPC extension harness would be mounted here (`mountOffscreenHost()`); it is not bundled yet.
      "anon:status": async ({ chainId }) => anonStatusFor(chainId, { harnessBundled: false }),
    }).then(sendResponse);
    return true;
  });
}

import type { Prover, ProveResult, RagequitProver, WithdrawCircuitInputs } from "@leaked/privacy";
import {
  OFFSCREEN_PATH,
  offscreenRequest,
  unwrapOffscreen,
  type OffscreenApi,
  type OffscreenKind,
} from "../shared/offscreen";

/** The parts of `chrome.offscreen` / `chrome.runtime` used here (injectable for unit tests). */
export interface OffscreenChrome {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  sendMessage(msg: unknown): Promise<unknown>;
}

/**
 * Service-worker side of the offscreen protocol (`shared/offscreen.ts`): creates the single offscreen document on
 * demand (reason WORKERS) and sends it typed requests. Concurrent first calls share one `createDocument`.
 */
export class OffscreenClient {
  private creating: Promise<void> | undefined;
  private seq = 0;

  constructor(private readonly chrome: OffscreenChrome) {}

  private async ensure(): Promise<void> {
    if (await this.chrome.hasDocument()) return;
    this.creating ??= this.chrome.createDocument().finally(() => {
      this.creating = undefined;
    });
    await this.creating;
  }

  async call<K extends OffscreenKind>(kind: K, payload: OffscreenApi[K]["req"]): Promise<OffscreenApi[K]["res"]> {
    await this.ensure();
    const res = await this.chrome.sendMessage(offscreenRequest(kind, payload, `${Date.now()}-${++this.seq}`));
    return unwrapOffscreen(kind, res);
  }

  /** A `Prover` whose proofs are made in the offscreen document's Worker. */
  prover(): Prover & RagequitProver {
    return {
      prove: (inputs: WithdrawCircuitInputs): Promise<ProveResult> => this.call("prove", { inputs }),
      proveRagequit: (inputs) => this.call("prove-ragequit", { inputs }),
    };
  }
}

/** The real Chrome APIs (service worker). */
export function chromeOffscreen(): OffscreenChrome {
  const c = (globalThis as unknown as { chrome: ChromeLike }).chrome;
  return {
    async hasDocument() {
      const contexts = await c.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      return contexts.length > 0;
    },
    async createDocument() {
      try {
        await c.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ["WORKERS"],
          justification: "Private balance: builds the zero-knowledge proof for a withdrawal in a Worker.",
        });
      } catch (e) {
        // Another caller created it in between ("Only a single offscreen document may be created").
        if (!/single offscreen/iu.test(String((e as Error).message))) throw e;
      }
    },
    sendMessage: (msg) => c.runtime.sendMessage(msg),
  };
}

interface ChromeLike {
  runtime: {
    getContexts(f: { contextTypes: string[] }): Promise<unknown[]>;
    sendMessage(msg: unknown): Promise<unknown>;
  };
  offscreen: { createDocument(o: { url: string; reasons: string[]; justification: string }): Promise<void> };
}

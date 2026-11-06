import { describe, expect, it } from "vitest";
import type { ProveResult, WithdrawCircuitInputs } from "@leaked/privacy";
import { OffscreenClient, type OffscreenChrome } from "../../src/background/offscreen";
import {
  OFFSCREEN_TARGET,
  answerOffscreen,
  anonStatusFor,
  decodeWire,
  encodeWire,
  isOffscreenRequest,
  offscreenRequest,
  unwrapOffscreen,
  type OffscreenApi,
  type OffscreenKind,
} from "../../src/shared/offscreen";

/**
 * The service worker ⇄ offscreen document protocol (plan §30 §2.3): typed requests with a `target` discriminator,
 * JSON-safe bigints, errors that keep their name, and one offscreen document created on demand.
 */

const inputs: WithdrawCircuitInputs = {
  withdrawnValue: 5n * 10n ** 16n,
  stateRoot: 2n ** 250n + 7n,
  stateTreeDepth: 3n,
  ASPRoot: 11n,
  ASPTreeDepth: 1n,
  context: 99n,
  label: 12345678901234567890n,
  existingValue: 10n ** 17n,
  existingNullifier: 1n,
  existingSecret: 2n,
  newNullifier: 3n,
  newSecret: 4n,
  stateSiblings: Array.from({ length: 32 }, (_, i) => BigInt(i)),
  stateIndex: 0n,
  ASPSiblings: Array.from({ length: 32 }, () => 0n),
  ASPIndex: 0n,
};

const result: ProveResult = {
  proof: {
    pA: [1n, 2n],
    pB: [
      [3n, 4n],
      [5n, 6n],
    ],
    pC: [7n, 8n],
    pubSignals: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
  },
  raw: {
    pi_a: ["1", "2", "1"],
    pi_b: [
      ["4", "3"],
      ["6", "5"],
      ["1", "0"],
    ],
    pi_c: ["7", "8", "1"],
  },
  publicSignals: ["1", "2", "3", "4", "5", "6", "7", "8"],
  ms: 2391,
};

describe("wire codec", () => {
  it("round-trips bigints (nested, in arrays) through JSON, the way chrome.runtime messages travel", () => {
    const wire = JSON.parse(JSON.stringify(encodeWire({ inputs, result })));
    expect(decodeWire(wire)).toEqual({ inputs, result });
    expect(JSON.stringify(encodeWire(1n))).toBe('{"$n":"1"}');
  });

  it("refuses a malformed bigint and keeps plain values", () => {
    expect(() => decodeWire({ $n: "0x10" })).toThrow(/bad bigint/);
    expect(() => decodeWire({ $n: 5 })).toThrow(/bad bigint/);
    expect(decodeWire({ $n: "-3" })).toBe(-3n);
    expect(decodeWire({ a: "1", b: [true, null] })).toEqual({ a: "1", b: [true, null] });
  });
});

describe("messages", () => {
  it("only well-formed requests for a known kind are offscreen requests (UI messages are not)", () => {
    const req = offscreenRequest("ping", {}, "1");
    expect(req.target).toBe(OFFSCREEN_TARGET);
    expect(isOffscreenRequest(req)).toBe(true);
    expect(isOffscreenRequest({ ...req, kind: "eval" })).toBe(false);
    expect(isOffscreenRequest({ ...req, id: 1 })).toBe(false);
    expect(isOffscreenRequest({ channel: "leaked-ui", type: "state:get" })).toBe(false);
    expect(isOffscreenRequest(null)).toBe(false);
  });

  it("answers through the handlers and re-throws errors with their name on the service worker side", async () => {
    const handlers = {
      ping: async () => ({ prover: "idle" as const, provedCount: 0 }),
      prove: async ({ inputs: got }: OffscreenApi["prove"]["req"]) => {
        expect(got).toEqual(inputs); // decoded on the offscreen side
        return result;
      },
      "anon:status": async () => {
        const e = new Error("boom");
        e.name = "ProofSelfCheckError";
        throw e;
      },
    };
    const proved = await answerOffscreen(
      JSON.parse(JSON.stringify(offscreenRequest("prove", { inputs }, "2"))),
      handlers,
    );
    expect(unwrapOffscreen("prove", JSON.parse(JSON.stringify(proved)))).toEqual(result);
    const failed = await answerOffscreen(offscreenRequest("anon:status", { chainId: 1 }, "3"), handlers);
    const err = (() => {
      try {
        unwrapOffscreen("anon:status", failed);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.name).toBe("ProofSelfCheckError");
    expect(() => unwrapOffscreen("ping", proved)).toThrow(/did not answer/);
    expect(() => unwrapOffscreen("ping", undefined)).toThrow(/did not answer/);
  });

  it("Anon-RPC: unavailable on the devnet and in a build without the harness, with the reason", () => {
    expect(anonStatusFor(1337, { harnessBundled: true })).toMatchObject({ available: false });
    expect(anonStatusFor(1337, { harnessBundled: true }).reason).toMatch(/devnet go direct/);
    expect(anonStatusFor(11155111, { harnessBundled: false }).reason).toMatch(/does not include/);
    expect(anonStatusFor(11155111, { harnessBundled: true })).toEqual({ available: true, reason: "" });
  });
});

describe("OffscreenClient", () => {
  const fakeChrome = () => {
    let exists = false;
    let creates = 0;
    const sent: unknown[] = [];
    const chrome: OffscreenChrome = {
      hasDocument: async () => exists,
      createDocument: async () => {
        creates++;
        await new Promise((r) => setTimeout(r, 5));
        exists = true;
      },
      sendMessage: async (msg) => {
        sent.push(msg);
        if (!exists) throw new Error("Could not establish connection. Receiving end does not exist.");
        const wire = JSON.parse(JSON.stringify(msg));
        if (!isOffscreenRequest(wire)) return undefined;
        return JSON.parse(
          JSON.stringify(
            await answerOffscreen(wire, {
              ping: async () => ({ prover: "ready", provedCount: 1 }),
              prove: async () => result,
              "anon:status": async ({ chainId }) => anonStatusFor(chainId, { harnessBundled: false }),
            }),
          ),
        );
      },
    };
    return { chrome, creates: () => creates, sent };
  };

  it("creates the one offscreen document once, even for concurrent first calls, then reuses it", async () => {
    const f = fakeChrome();
    const c = new OffscreenClient(f.chrome);
    const [a, b] = await Promise.all([c.call("ping", {}), c.call("anon:status", { chainId: 1337 })]);
    expect(a).toEqual({ prover: "ready", provedCount: 1 });
    expect(b.available).toBe(false);
    await c.call("ping", {});
    expect(f.creates()).toBe(1);
    expect(f.sent.every((m) => isOffscreenRequest(m))).toBe(true);
    expect(new Set(f.sent.map((m) => (m as { id: string }).id)).size).toBe(f.sent.length);
  });

  it("prover(): a Prover whose proofs come back from the offscreen Worker with bigints intact", async () => {
    const c = new OffscreenClient(fakeChrome().chrome);
    const r = await c.prover().prove(inputs);
    expect(r.proof.pubSignals[7]).toBe(8n);
    expect(r).toEqual(result);
  });

  it("every request kind has a handler type (compile-time map stays exhaustive)", () => {
    const kinds: OffscreenKind[] = ["ping", "prove", "anon:status"];
    for (const k of kinds) expect(isOffscreenRequest(offscreenRequest(k, {} as never, "x"))).toBe(true);
  });
});

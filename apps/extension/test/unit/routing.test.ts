import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  MAX_HOT_CALLS,
  callShape,
  decideRoute,
  routeCopy,
  type ClassifiedCall,
  type PolicySnapshot,
} from "../../src/background/routing";

const USD = 1_000_000n;
const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

/** Deterministic PRNG (mulberry32) so failures reproduce from the printed seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(r: () => number) {
  const big = (max: number) => BigInt(Math.floor(r() * max)) * USD;
  const cap = big(1000) + USD;
  const policy: PolicySnapshot = {
    deployed: r() > 0.1,
    frozen: r() < 0.1,
    bunker: r() < 0.05,
    capUsd: cap,
    availableUsd: (cap * BigInt(Math.floor(r() * 101))) / 100n,
    perTxMaxUsd: big(500) + USD,
  };
  const n = r() < 0.05 ? 0 : r() < 0.05 ? MAX_HOT_CALLS + 1 : 1 + Math.floor(r() * 4);
  const calls: ClassifiedCall[] = Array.from({ length: n }, () => {
    const kind = (["eth-transfer", "token-transfer", "contract-call"] as const)[Math.floor(r() * 3)]!;
    return {
      call: { target: A, value: 0n, data: "0x" as Hex },
      kind,
      recipient: A,
      assetAllowed: r() > 0.15,
      recipientAllowed: r() > 0.2,
      sessionMatch: r() > 0.7,
      usd: big(300),
      amount: 1n,
    };
  });
  const sim = r() < 0.5 ? undefined : { admitted: r() > 0.1, bodyOk: r() > 0.1 };
  return { policy, calls, sim };
}

describe("routing decision table (plan §30 §5.2), property-tested", () => {
  it("never routes to the everyday key what the account would refuse; rule ids match the reasons", () => {
    for (let seed = 1; seed <= 5000; seed++) {
      const { policy, calls, sim } = randomCase(rng(seed));
      const d = decideRoute(policy, calls, sim);
      const total = calls.reduce((s, c) => s + c.usd, 0n);
      const ctx = `seed ${seed}`;
      expect(d.amountUsd, ctx).toBe(total);
      // Row 1 (and activation) dominate everything.
      if (!policy.deployed) {
        expect(d.route, ctx).toBe("not-activated");
        continue;
      }
      if (policy.bunker) {
        expect(d.rules, ctx).toEqual(["ROUTE-BUNKER"]);
        continue;
      }
      if (policy.frozen) {
        expect(d.rules, ctx).toEqual(["ROUTE-FROZEN"]);
        continue;
      }
      if (calls.length === 0 || calls.length > MAX_HOT_CALLS) {
        expect(d.route, ctx).toBe("blocked");
        continue;
      }
      const targetBad = calls.some(
        (c) => (c.kind === "contract-call" && !c.sessionMatch) || (c.kind !== "contract-call" && !c.recipientAllowed),
      );
      const tokenBad = calls.some((c) => c.kind !== "contract-call" && !c.assetAllowed);
      const perTx = total > policy.perTxMaxUsd;
      const cap = total > policy.availableUsd;
      const staticOk = !targetBad && !tokenBad && !perTx && !cap;
      const simOk = !sim || (sim.admitted && sim.bodyOk);
      expect(d.route === "hot", ctx).toBe(staticOk && simOk);
      if (d.route === "hot") {
        expect(d.rules, ctx).toEqual(["ROUTE-HOT-OK"]);
        expect(d.leftAfterUsd, ctx).toBe(policy.availableUsd - total);
        expect(total <= policy.perTxMaxUsd && total <= policy.availableUsd, ctx).toBe(true);
      } else {
        expect(d.route, ctx).toBe("needs-vault");
        expect(d.rules[0], ctx).toBe("ROUTE-NEEDS-VAULT");
        expect(d.rules.includes("TARGET-NOT-ALLOWED"), ctx).toBe(targetBad);
        expect(d.rules.includes("TOKEN-NOT-ALLOWED"), ctx).toBe(tokenBad);
        expect(d.rules.includes("PER-PAYMENT-LIMIT"), ctx).toBe(perTx);
        expect(d.rules.includes("CAP-EXCEEDED"), ctx).toBe(cap);
        expect(d.rules.includes("SIM-REJECTED"), ctx).toBe(staticOk && !simOk);
        expect(new Set(d.rules).size, ctx).toBe(d.rules.length);
      }
      // The copy always exists and says something for every outcome.
      const copy = routeCopy(d, policy);
      expect(copy.headline.length > 0 && copy.detail.length > 0, ctx).toBe(true);
    }
  });

  it("copy follows ux-spec §3.3.1", () => {
    const policy: PolicySnapshot = {
      deployed: true,
      frozen: false,
      bunker: false,
      capUsd: 500n * USD,
      availableUsd: 458n * USD,
      perTxMaxUsd: 200n * USD,
    };
    const c = (usd: bigint, over: Partial<ClassifiedCall> = {}): ClassifiedCall => ({
      call: { target: A, value: 0n, data: "0x" },
      kind: "eth-transfer",
      recipient: A,
      assetAllowed: true,
      recipientAllowed: true,
      sessionMatch: false,
      usd,
      amount: 1n,
      ...over,
    });
    expect(routeCopy(decideRoute(policy, [c(120n * USD)]), policy)).toMatchObject({
      tone: "safe",
      headline: "Instant: within your daily limit",
      detail: "Uses $120 of $458 left today",
    });
    expect(routeCopy(decideRoute(policy, [c(250n * USD)]), policy).detail).toMatch(
      /^Above your \$200 per-payment limit/u,
    );
    expect(routeCopy(decideRoute({ ...policy, availableUsd: 100n * USD }, [c(150n * USD)]), policy).detail).toMatch(
      /^Over what's left today/u,
    );
    const stranger = routeCopy(decideRoute(policy, [c(USD, { recipientAllowed: false })]), policy, () => "0x7099…79C8");
    expect(stranger).toMatchObject({ tone: "vault", headline: "Needs your phone" });
    expect(stranger.detail).toMatch(/^0x7099…79C8 isn't on your allowed list yet/u);
  });

  it("classifies call shapes", () => {
    expect(callShape({ target: A, value: 5n, data: "0x" })).toMatchObject({ kind: "eth-transfer", amount: 5n });
    const transfer =
      `0xa9059cbb${A.slice(2).toLowerCase().padStart(64, "0")}${7n.toString(16).padStart(64, "0")}` as Hex;
    expect(
      callShape({ target: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", value: 0n, data: transfer }),
    ).toMatchObject({
      kind: "token-transfer",
      amount: 7n,
    });
    expect(callShape({ target: A, value: 0n, data: "0x12345678" }).kind).toBe("contract-call");
    // A transfer with ETH attached is not a plain token transfer (the account refuses it too).
    expect(callShape({ target: A, value: 1n, data: transfer }).kind).toBe("contract-call");
  });
});

import { describe, expect, it } from "vitest";
import { publicDeployment } from "../../src/generated/contracts";
import { choosePath, STOCK_VERIFY_BUDGET } from "../../src/background/lanes";
import { DEVNET_CAPABILITIES, explorerTxLink, findNetwork, PUBLIC_EXPLORER_TX } from "../../src/shared/chains";

// A normal (store) build: chain 1337 is the public alt-mempool devnet.
describe("devnet profiles", () => {
  it("the public devnet: QueueBit's recorded deployment, its explorer, no staged budget or precompiles", () => {
    const net = findNetwork(1337)!;
    expect(net.rpcUrl).toBe("https://altmempool.forshtat.com");
    expect(net.stakedSidecarUrl).toBeUndefined();
    expect(net.capabilities).toEqual(DEVNET_CAPABILITIES.public);
    expect(net.capabilities).toEqual({ stagedBudget: false, precompilesAllowed: false, has4337: false });
    expect(net.deployment?.factory).toBe(publicDeployment!.factory);
    expect(net.deployment?.stakingRegistry.toLowerCase()).toBe("0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f");
    const h = `0x${"ab".repeat(32)}`;
    expect(explorerTxLink(net, h)).toBe(PUBLIC_EXPLORER_TX.replace("{hash}", h));
    expect(explorerTxLink(net, "0x1234")).toBeUndefined();
    expect(findNetwork(31337)).toBeUndefined();
  });

  it("routing on the public devnet never asks for more than the flat 100k in VERIFY", () => {
    const stock = { standard: STOCK_VERIFY_BUDGET }; // what Vault.budgets() measures there (no staked lane)
    for (const schemeVerifyGas of [10_000n, 50_000n, 54_900n, 55_000n, 120_000n, 400_000n])
      for (const signerStaked of [false, true]) {
        const c = choosePath({ schemeVerifyGas, hasPayer: true, signerStaked, budgets: stock });
        expect(c.ok).toBe(true);
        if (c.ok) {
          expect(c.lane).toBe("standard");
          // VERIFY limit + the signature costs the sidecar adds (ARBITRARY 100; Path B also secp256k1 2,800).
          expect(c.verifyGas + (c.path === "B" ? 2_900n : 100n)).toBeLessThanOrEqual(STOCK_VERIFY_BUDGET);
        }
      }
    // C13 (VERIFY_GAS_ESTIMATE 120k, 151,701 measured on Path A) goes to Path B; leanSphincs-s (50k, 84,465) stays on A.
    expect(choosePath({ schemeVerifyGas: 120_000n, hasPayer: true, signerStaked: true, budgets: stock })).toMatchObject(
      {
        path: "B",
      },
    );
    expect(choosePath({ schemeVerifyGas: 50_000n, hasPayer: true, signerStaked: false, budgets: stock })).toMatchObject(
      {
        path: "A",
      },
    );
  });
});

describe("standard-lane submission through a devnet's sidecar (explorer indexing)", () => {
  const net = { ...findNetwork(1337)!, sidecarUrl: "https://s.example/rpc" };
  const tx = {} as never;
  const h = `0x${"cd".repeat(32)}` as const;
  const calls: string[] = [];
  const node = (fail?: string) =>
    ({
      sendRawTransaction: async () => {
        calls.push("node");
        if (fail) throw new Error(fail);
        return h;
      },
    }) as never;
  const sidecar = (fail?: boolean) => () =>
    ({
      sendFrameTransaction: async () => {
        calls.push("sidecar");
        if (fail) throw new Error("refused");
        return h;
      },
    }) as never;

  it("uses the sidecar when the network asks for it, the node otherwise or as the fallback", async () => {
    const { submitStandardLane } = await import("../../src/background/submit");
    calls.length = 0;
    expect(await submitStandardLane({ net, raw: "0x06", tx, expectedHash: h, node: node(), sidecar: sidecar() })).toBe(
      h,
    );
    expect(calls).toEqual(["sidecar"]);
    calls.length = 0;
    await submitStandardLane({ net, raw: "0x06", tx, expectedHash: h, node: node(), sidecar: sidecar(true) });
    expect(calls).toEqual(["sidecar", "node"]);
    calls.length = 0;
    const off = { ...net, submitViaSidecar: false };
    await submitStandardLane({ net: off, raw: "0x06", tx, expectedHash: h, node: node(), sidecar: sidecar() });
    expect(calls).toEqual(["node"]);
    // The sidecar forwarded it before failing: the node's "already known" keeps the expected hash.
    expect(
      await submitStandardLane({
        net,
        raw: "0x06",
        tx,
        expectedHash: h,
        node: node("already known"),
        sidecar: sidecar(true),
      }),
    ).toBe(h);
    await expect(
      submitStandardLane({
        net,
        raw: "0x06",
        tx,
        expectedHash: h,
        node: node("nonce too low"),
        sidecar: sidecar(true),
      }),
    ).rejects.toThrow(/nonce too low/u);
  });
});

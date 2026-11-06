// Contract-in-the-loop (plan §30 §10.1) on the LOCAL devnet (devnet/README.md) with the devnet/deploy contracts:
//   LOCAL_DEVNET=1 VITE_QUEUEBIT_LOCAL_DEVNET=1 pnpm vitest run test/devnet
// Funds from anvil #7 only (the extension e2e key). Activates a fresh account through the Wallet's service-worker
// code, sends an everyday payment, and checks that over-limit and not-allowed payments are classified before
// submission and never reach eth_sendRawTransaction.
import { createWalletClient, http, parseEther, toHex, type Address, type Hex } from "viem";
import { SCHEME_ID, keygen } from "@queuebit/pq-signer";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createFrameRpc } from "@queuebit/rpc";
import { RouteError } from "../../src/background/payments";
import { publicClient, nodeClient } from "../../src/background/rpc";
import { Wallet } from "../../src/background/wallet";
import { accountFactoryAbi, localDeployment } from "../../src/generated/contracts";
import { MemoryKV } from "../../src/shared/kv";

vi.mock("../../src/shared/build", () => ({
  SHARED_DEVNET: false,
  SHARED_DEVNET_BASE: "",
  LOCAL_DEVNET: true,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: true, designGallery: false },
}));

const RUN = process.env.LOCAL_DEVNET === "1";
const FUNDER: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil #7
const CHAIN = 1337;

async function fund(to: Address, value: bigint) {
  const w = createWalletClient({ transport: http("http://localhost:8545"), account: privateKeyToAccount(FUNDER) });
  const hash = await w.sendTransaction({
    to,
    value,
    gas: 250_000n,
    gasPrice: 2_000_000_000n,
    type: "legacy",
    chain: null,
  });
  await publicClient(CHAIN).waitForTransactionReceipt({ hash, timeout: 180_000 });
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("timeout");
}

describe.runIf(RUN)("payments on the local devnet", () => {
  it("activate → fund → everyday payment mined → over-limit / not-allowed classified before submission", async () => {
    const sent: Hex[] = [];
    const wallet = new Wallet({
      local: new MemoryKV(),
      session: new MemoryKV(),
      windows: { open: async () => 1, focus: async () => true, exists: async () => true },
      readRpc: async () => null,
      getBalance: async () => 0n,
      emit: () => undefined,
      keyring: { scrypt: { N: 2 ** 10, r: 8, p: 1 } },
      io: {
        publicClient,
        node: (id) => {
          const n = nodeClient(id);
          return {
            ...n,
            sendRawTransaction: async (raw: Hex) => {
              sent.push(raw);
              return n.sendRawTransaction(raw);
            },
          };
        },
      },
    });
    await wallet.keyring.create("password-1");
    await wallet.settings.updateSetup({ dailyLimitUsd: 20, perPaymentUsd: 10 });
    // A paired Vault (test key material; the account's address commits to its public key).
    await wallet.settings.setPaired("vault", {
      schemeId: SCHEME_ID,
      pk: toHex(keygen(new Uint8Array(64).fill(Date.now() % 251), { role: "vault" }).publicKey),
      payer: "0x00000000000000000000000000000000000000fa",
      at: Date.now(),
    });
    const payments = wallet.payments!;
    await payments.computePlan(CHAIN);

    const before = await payments.status(CHAIN);
    expect(before.supported).toBe(true);
    expect(before.deployed).toBe(false);
    // The counterfactual address equals the factory's own prediction.
    const plan = (await payments.plan(CHAIN))!;
    const predicted = await publicClient(CHAIN).readContract({
      address: localDeployment!.factory,
      abi: accountFactoryAbi,
      functionName: "predictAccount",
      args: [plan.salt, plan.implementation, plan.initData],
    });
    expect(predicted).toBe(plan.address);

    await expect(payments.activate(CHAIN)).rejects.toMatchObject({ reason: "tank-low" });
    await fund(before.tank, parseEther("0.08"));
    await fund(before.address, parseEther("0.05"));
    const act = await payments.activate(CHAIN);
    await until(async () => {
      await payments.refreshPending();
      const e = await wallet.activity.get(act.id);
      return e?.status === "confirmed" ? e : undefined;
    });
    const active = await payments.status(CHAIN);
    expect(active.deployed).toBe(true);
    expect(active.limits).toMatchObject({ capUsd: 20, perTxMaxUsd: 10, availableUsd: 20 });

    // Everyday payment: a fee-tank top-up of $3 (allowlisted at initialize).
    const topUp = [{ target: active.tank, value: parseEther("0.001"), data: "0x" as Hex }];
    const preview = await payments.preview(CHAIN, topUp);
    expect(preview.route.route).toBe("hot");
    expect(preview.route.rules).toEqual(["ROUTE-HOT-OK"]);
    const entry = await payments.send(CHAIN, topUp);
    const done = await until(async () => {
      await payments.refreshPending();
      const e = await wallet.activity.get(entry.id);
      return e?.status === "confirmed" || e?.status === "failed" ? e : undefined;
    });
    expect(done.status).toBe("confirmed");
    expect(done.headline).toBe("Paid 0.001 ETH to your fee tank");
    expect(done.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    const receipt = await createFrameRpc("http://localhost:8545").node.getTransactionReceipt(done.hash);
    expect(receipt?.frameReceipts.map((f) => f.status)).toEqual(["success", "success", "success"]);
    expect((await payments.status(CHAIN)).limits.availableUsd).toBeLessThan(20);

    // Over the per-payment limit ($15 > $10): needs the Vault, decided before anything is signed or sent.
    const sentBefore = sent.length;
    const big = [{ target: active.tank, value: parseEther("0.005"), data: "0x" as Hex }];
    const overview = await payments.preview(CHAIN, big);
    expect(overview.route.route).toBe("needs-vault");
    expect(overview.route.rules).toEqual(["ROUTE-NEEDS-VAULT", "PER-PAYMENT-LIMIT"]);
    await expect(payments.send(CHAIN, big)).rejects.toBeInstanceOf(RouteError);
    // Open recipient mode: a fresh address is an everyday payment; a contract call to it is not.
    const stranger = "0x000000000000000000000000000000000000dEaD" as Address;
    const pv = await payments.preview(CHAIN, [
      {
        target: "0x1234567890123456789012345678901234567891" as Address,
        value: parseEther("0.003"),
        data: "0x" as Hex,
      },
    ]);
    expect(pv.route.route).toBe("hot");
    expect(
      (await payments.preview(CHAIN, [{ target: stranger, value: 0n, data: "0x12345678" as Hex }])).route.rules,
    ).toContain("TARGET-NOT-ALLOWED");
    expect(sent.length).toBe(sentBefore);
  }, 600_000);
});

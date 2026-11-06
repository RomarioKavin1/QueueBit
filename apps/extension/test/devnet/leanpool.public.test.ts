// The quantum-safe everyday key through the extension's own service-worker code, on the PUBLIC alt-mempool devnet
// (chain 1337, altmempool.forshtat.com) with QueueBit's deployment there and a running LeanPool node:
//
//   LEANPOOL_PUBLIC_E2E=1 DEPLOYER_KEY=0x… LEANPOOL_NODE_URL=http://127.0.0.1:8711 pnpm vitest run test/devnet/leanpool
//
// Onboarding (a phone stand-in made with the companion's own worker), activation, Security › Quantum-safe › Set up (the
// fee tank creates the signer), the Vault approval (the companion's reviewer and signer answer the extension's
// request), then an everyday payment that goes through LeanPool, followed to mined in the activity. Then the node
// "goes down" and the next payment falls back to the everyday key, saying so.
import { createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { SCHEME_ID } from "@queuebit/pq-signer";
import { createFrameRpc, createLeanPoolClient, httpTransport } from "@queuebit/rpc";
import { publicClient, nodeClient } from "../../src/background/rpc";
import { Wallet } from "../../src/background/wallet";
import { MemoryKV } from "../../src/shared/kv";
import { reviewRequestBytes } from "../../../companion/src/core/clearsign";
import { entropyToWords, wordsToEntropy } from "../../../companion/src/core/keys";
import { handle } from "../../../companion/src/worker/handler";

const NODE = process.env.LEANPOOL_NODE_URL ?? "http://127.0.0.1:8711";
vi.mock("../../src/shared/build", () => ({
  SHARED_DEVNET: false,
  SHARED_DEVNET_BASE: "",
  LOCAL_DEVNET: false,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: false, designGallery: false },
  BUILD_RELAY_URL: "",
  BUILD_COMPANION_URL: "",
  BUILD_FAUCET_URL: "",
}));
vi.mock("../../src/shared/leanpoolBuild", () => ({
  BUILD_LEANPOOL_URL: process.env.LEANPOOL_NODE_URL ?? "http://127.0.0.1:8711",
}));

const RUN = process.env.LEANPOOL_PUBLIC_E2E === "1";
const RPC = "https://altmempool.forshtat.com";
const CHAIN = 1337;
const PASS = "phone-passphrase-1";

async function fund(to: Address, value: bigint) {
  const w = createWalletClient({ transport: http(RPC), account: privateKeyToAccount(process.env.DEPLOYER_KEY as Hex) });
  const hash = await w.sendTransaction({ to, value, gas: 250_000n, gasPrice: 2_000_000_000n, type: "legacy", chain: null });
  await publicClient(CHAIN).waitForTransactionReceipt({ hash, timeout: 180_000 });
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 300_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("timeout");
}

/** The phone, made with the companion's own worker: it decodes and clear-signs exactly as the app does. */
async function phone() {
  const words = entropyToWords(crypto.getRandomValues(new Uint8Array(32)));
  const created = await handle(
    { op: "create", entropy: wordsToEntropy(words), bip39Passphrase: "", passphrase: PASS, kdf: { N: 2 ** 10, r: 8, p: 1 }, restored: false },
    () => undefined,
  );
  if (created.op !== "create") throw new Error("create");
  return {
    pk: created.vaultPk,
    payer: created.payerAddress,
    async approve(cborHex: Hex) {
      const cbor = Uint8Array.from(Buffer.from(cborHex.slice(2), "hex"));
      const review = reviewRequestBytes(cbor, {
        mode: "vault",
        publicKey: created.vaultPk,
        schemeId: SCHEME_ID,
        payerAddress: created.payerAddress,
        addressBook: [],
        snapshots: [],
      });
      const r = await handle(
        { op: "sign", mode: "vault", sealed: created.sealed, vaultPk: created.vaultPk, passphrase: PASS, requestCbor: cbor, expectDigest: review.digest, allowUnknown: false },
        () => undefined,
      );
      if (r.op !== "sign") throw new Error("sign");
      return { review, signatureCbor: `0x${Buffer.from(r.signatureCbor).toString("hex")}` as Hex };
    },
  };
}

describe.runIf(RUN)("the quantum-safe everyday key on the public devnet (extension code end to end)", () => {
  it("set up → Vault approves → payment through LeanPool mined → node down → falls back to the everyday key", async () => {
    let nodeUp = true;
    const real = createLeanPoolClient(httpTransport(NODE, { timeoutMs: 15_000 }));
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
        node: nodeClient,
        leanpool: () => ({
          ...real,
          status: async () => {
            if (!nodeUp) throw new Error("unreachable");
            return real.status();
          },
          sendTransaction: async (raw, sigs) => {
            if (!nodeUp) throw new Error("unreachable");
            return real.sendTransaction(raw, sigs);
          },
        }),
      },
    });
    const p = await phone();
    await wallet.keyring.create("password-1");
    await wallet.settings.updateSetup({ dailyLimitUsd: 20, perPaymentUsd: 10 });
    await wallet.settings.setPaired("vault", { schemeId: SCHEME_ID, pk: p.pk, payer: p.payer, at: Date.now() });
    const payments = wallet.payments!;
    await payments.computePlan(CHAIN);
    const before = await payments.status(CHAIN);
    await fund(before.tank, parseEther("0.2"));
    await fund(before.address, parseEther("0.05"));
    const act = await payments.activate(CHAIN);
    await until(async () => {
      await payments.refreshPending();
      const e = await wallet.activity.get(act.id);
      return e?.status === "confirmed" ? e : e?.status === "failed" ? Promise.reject(new Error(e.headline)) : undefined;
    });
    // The Vault signer pays for its approvals.
    const plan = (await wallet.plans.get(CHAIN))!;
    await fund(plan.vaultSigner!, parseEther("0.05"));

    // Security › Quantum-safe everyday key.
    expect(await wallet.handleUi("pq:status", {})).toMatchObject({ state: "off", nodeOk: true });
    const prepared = await wallet.handleUi("pq:prepare", {});
    expect(prepared).toMatchObject({ state: "awaiting-vault", preferred: true });
    expect((await publicClient(CHAIN).getCode({ address: prepared.signer! }))?.length).toBeGreaterThan(2);

    // The Vault approval, through the extension's Vault flow and the companion's reviewer and signer.
    const rec = await wallet.handleUi("vault:create", { action: { type: "setPQHotSigner", signer: prepared.signer! } });
    const answer = await p.approve(rec.cbor);
    expect(answer.review.unknown).toBe(false);
    expect(answer.review.mismatch).toEqual([]);
    expect(answer.review.headline).toMatch(/quantum-safe everyday key/u);
    await wallet.handleUi("vault:submit", { id: rec.id, signature: answer.signatureCbor });
    const on = await until(async () => {
      await wallet.vault!.refresh();
      const v = await wallet.handleUi("pq:status", {});
      return v.state === "on" ? v : undefined;
    });
    expect(on).toMatchObject({ state: "on", active: true });

    // An everyday payment ($3 to the fee tank): previewed as quantum-safe, sent through LeanPool, mined.
    const pay = [{ target: before.tank, value: parseEther("0.001"), data: "0x" as Hex }];
    const preview = await payments.preview(CHAIN, pay);
    expect(preview.route.route).toBe("hot");
    expect(preview.signingKey?.kind).toBe("quantum-safe");
    const entry = await payments.send(CHAIN, pay);
    expect(entry.lane).toBe("leanpool");
    const done = await until(async () => {
      await payments.refreshPending();
      const e = await wallet.activity.get(entry.id);
      return e?.status === "confirmed" || e?.status === "failed" ? e : undefined;
    });
    expect(done.status).toBe("confirmed");
    expect(done.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);
    const receipt = await createFrameRpc(RPC).node.getTransactionReceipt(done.hash);
    expect(receipt?.frameReceipts.map((f) => f.status)).toEqual(["success", "success"]);
    expect(receipt!.frameReceipts[0]!.gasUsed.execution).toBeLessThan(100_000n);
    console.log(`PQ everyday payment mined: ${done.hash} (block ${done.blockNumber}, VERIFY ${receipt!.frameReceipts[0]!.gasUsed.execution} gas)`);

    // LeanPool goes down: the next payment uses the everyday key and says so.
    nodeUp = false;
    const fb = await payments.preview(CHAIN, pay);
    expect(fb.signingKey).toMatchObject({ kind: "everyday" });
    const e2 = await payments.send(CHAIN, pay);
    expect(e2.lane).toBeUndefined();
    expect(e2.fallbackNote).toMatch(/LeanPool/u);
    const done2 = await until(async () => {
      await payments.refreshPending();
      const e = await wallet.activity.get(e2.id);
      return e?.status === "confirmed" || e?.status === "failed" ? e : undefined;
    });
    expect(done2.status).toBe("confirmed");
  }, 1_200_000);
});

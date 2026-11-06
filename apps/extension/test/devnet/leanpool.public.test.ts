// The quantum-safe everyday key through the extension's own service-worker code, on the PUBLIC alt-mempool devnet
// (chain 1337, altmempool.forshtat.com) with QueueBit's deployment there and a running LeanPool node:
//
//   LEANPOOL_PUBLIC_E2E=1 DEPLOYER_KEY=0x… LEANPOOL_NODE_URL=http://127.0.0.1:8711 pnpm vitest run test/devnet/leanpool
//
// Onboarding (a phone stand-in made with the companion's own worker), activation, Security › Quantum-safe › Set up (the
// fee tank creates the signer), the Vault approval (the companion's reviewer and signer answer the extension's
// request), which queues the install behind the account's 48 h timelock. The payment through LeanPool after the
// timelock is covered by contracts/devnet-tests/leanpool (1 h timelock) and the unit suite.
import { createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { SCHEME_ID } from "@queuebit/pq-signer";
import { createFrameRpc, createLeanPoolClient, httpTransport } from "@queuebit/rpc";
import { publicClient, nodeClient } from "../../src/background/rpc";
import { Wallet } from "../../src/background/wallet";
import { MemoryKV } from "../../src/shared/kv";
import { ACCOUNT_DEFAULTS } from "../../src/background/account";
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
/**
 * FULL=1: the account gets the contract's minimum timelock (1 h, test-only: the extension itself leaves the 48 h
 * default) so the run continues past the queued approval: Finish, a payment through LeanPool mined, then the node down
 * and the fallback. About 70 minutes.
 */
const FULL = process.env.LEANPOOL_PUBLIC_E2E_FULL === "1";
const RPC = "https://altmempool.forshtat.com";
const CHAIN = 1337;
const PASS = "phone-passphrase-1";

async function fund(to: Address, value: bigint) {
  const w = createWalletClient({ transport: http(RPC), account: privateKeyToAccount(process.env.DEPLOYER_KEY as Hex) });
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
    {
      op: "create",
      entropy: wordsToEntropy(words),
      bip39Passphrase: "",
      passphrase: PASS,
      kdf: { N: 2 ** 10, r: 8, p: 1 },
      restored: false,
    },
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
        {
          op: "sign",
          mode: "vault",
          sealed: created.sealed,
          vaultPk: created.vaultPk,
          passphrase: PASS,
          requestCbor: cbor,
          expectDigest: review.digest,
          allowUnknown: false,
        },
        () => undefined,
      );
      if (r.op !== "sign") throw new Error("sign");
      return { review, signatureCbor: `0x${Buffer.from(r.signatureCbor).toString("hex")}` as Hex };
    },
  };
}

describe.runIf(RUN)("the quantum-safe everyday key on the public devnet (extension code end to end)", () => {
  it("set up → the Vault approves → the install is queued behind the timelock (extension code end to end)", async () => {
    const real = createLeanPoolClient(httpTransport(NODE, { timeoutMs: 15_000 }));
    let nodeUp = true;
    if (FULL) (ACCOUNT_DEFAULTS as { timelockDelay: number }).timelockDelay = 3600;
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
    // Installing a spender is loosening: the Vault's approval queues it behind the account's timelock (48 h for an
    // extension-made account). The Security row shows it approved, with its ETA; nothing is installed before then.
    const queued = await until(async () => {
      await wallet.vault!.refresh();
      const q = await wallet.handleUi("vault:queue", {});
      return q.find((x) => x.state === "pending" && x.title.startsWith("Use a quantum-safe everyday key"));
    });
    expect(queued.eta - queued.chainNow).toBeGreaterThan(FULL ? 3000 : 47 * 3600);
    expect(queued.executable).toBe(true); // this wallet holds the calls to execute it after the ETA
    expect(queued.chainNow).toBeLessThan(queued.eta);
    expect(await wallet.handleUi("pq:status", {})).toMatchObject({ state: "awaiting-vault" });
    // Meanwhile everyday payments use the regular key, with no quantum-safe note (it isn't on yet).
    const pay = [{ target: before.tank, value: parseEther("0.001"), data: "0x" as Hex }];
    const preview = await payments.preview(CHAIN, pay);
    expect(preview.route.route).toBe("hot");
    expect(preview.signingKey).toBeUndefined();
    console.log(`queued: op ${queued.opId}, takes effect at ${new Date(queued.eta * 1000).toISOString()}`);
    if (!FULL) return;

    // After the timelock: Finish (anyone may execute the queued op; the wallet holds its calls).
    await until(async () => {
      const b = await publicClient(CHAIN).getBlock({ blockTag: "latest" });
      return b.timestamp >= BigInt(queued.eta) ? true : undefined;
    }, 4_200_000);
    await wallet.handleUi("vault:executeQueued", { opId: queued.opId });
    const on = await until(async () => {
      const v = await wallet.handleUi("pq:status", {});
      return v.state === "on" ? v : undefined;
    });
    expect(on).toMatchObject({ active: true });

    // A payment through LeanPool, followed to mined in the activity.
    const pqPreview = await payments.preview(CHAIN, pay);
    expect(pqPreview.signingKey?.kind).toBe("quantum-safe");
    const entry = await payments.send(CHAIN, pay);
    expect(entry.lane).toBe("leanpool");
    const done = await until(async () => {
      await payments.refreshPending();
      const e = await wallet.activity.get(entry.id);
      return e?.status === "confirmed" || e?.status === "failed" ? e : undefined;
    });
    expect(done.status).toBe("confirmed");
    expect(done.steps.map((x) => x.status)).toEqual(["done", "done", "done", "done"]);
    expect(done.pqBatch?.root).toMatch(/^0x/u);
    const receipt = await createFrameRpc(RPC).node.getTransactionReceipt(done.hash);
    expect(receipt?.frameReceipts.map((f) => f.status)).toEqual(["success", "success"]);
    expect(receipt!.frameReceipts[0]!.gasUsed.execution).toBeLessThan(100_000n);
    console.log(`PQ everyday payment mined through the extension: ${done.hash} (block ${done.blockNumber})`);

    // LeanPool down at the check: the everyday key, with a note; confirmed.
    nodeUp = false;
    const fb = await payments.send(CHAIN, pay);
    expect(fb.lane).toBeUndefined();
    expect(fb.fallbackNote).toMatch(/LeanPool/u);
    const fbDone = await until(async () => {
      await payments.refreshPending();
      const e = await wallet.activity.get(fb.id);
      return e?.status === "confirmed" || e?.status === "failed" ? e : undefined;
    });
    expect(fbDone.status).toBe("confirmed");
  }, 6_000_000);
});

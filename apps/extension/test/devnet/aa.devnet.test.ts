// Contract-in-the-loop for the 4337 backend (plan §30 §10.1) on a local anvil with EntryPoint v0.8, the QueueBit 7579
// modules and the minimal bundler (devnet/deploy: `bun run up:4337`):
//   LOCAL_4337=1 VITE_QUEUEBIT_LOCAL_DEVNET=1 pnpm vitest run test/devnet/aa.devnet.test.ts
// Funds from anvil #7. Computes the account with the paired Vault and a token, activates it, sends an everyday
// userOp through the bundler, classifies an over-limit payment before submission, and runs a Vault approval through
// QueueBitRoleExecutor.vaultExec with a C13 signature over the executor's EIP-712 digest (checked against the chain).
import { createPublicClient, createWalletClient, decodeFunctionData, hexToBytes, http, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SCHEME_ID, keygen, sign } from "@queuebit/pq-signer";
import { decodeSignRequest, encodeSignature, TX_TYPE } from "@queuebit/ur";
import { describe, expect, it, vi } from "vitest";
import { executorDigest } from "../../src/background/aa/executor";
import { publicClient, nodeClient } from "../../src/background/rpc";
import { Wallet } from "../../src/background/wallet";
import { local4337Deployment, roleExecutorAbi } from "../../src/generated/contracts";
import { MemoryKV } from "../../src/shared/kv";

vi.mock("../../src/shared/build", () => ({
  LOCAL_DEVNET: true,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: true, designGallery: false },
}));

const RUN = process.env.LOCAL_4337 === "1";
const RPC = "http://localhost:8546";
const FUNDER: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil #7
const CHAIN = 31337;
const pub = createPublicClient({ transport: http(RPC) });

async function fund(to: Address, value: bigint) {
  const w = createWalletClient({ transport: http(RPC), account: privateKeyToAccount(FUNDER) });
  const hash = await w.sendTransaction({ to, value, chain: null });
  await pub.waitForTransactionReceipt({ hash });
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timeout");
}

describe.runIf(RUN && local4337Deployment)("4337 backend on a local anvil", () => {
  it("compute → activate → hot userOp mined → over-limit needs the Vault → vaultExec with a C13 signature", async () => {
    const dep = local4337Deployment!;
    const wallet = new Wallet({
      local: new MemoryKV(),
      session: new MemoryKV(),
      windows: { open: async () => 1, focus: async () => true, exists: async () => true },
      readRpc: async () => null,
      getBalance: async () => 0n,
      emit: () => undefined,
      keyring: { scrypt: { N: 2 ** 10, r: 8, p: 1 } },
      io: { publicClient, node: nodeClient },
    });
    await wallet.keyring.create("password-1");
    await wallet.settings.update({ selectedChainId: CHAIN });
    await wallet.settings.updateSetup({ dailyLimitUsd: 500, perPaymentUsd: 200 });
    const vault = keygen(crypto.getRandomValues(new Uint8Array(64)), { role: "vault" });
    await wallet.settings.setPaired("vault", {
      schemeId: SCHEME_ID,
      pk: toHex(vault.publicKey),
      payer: "0x00000000000000000000000000000000000000fa",
      at: Date.now(),
    });
    const recovery = keygen(crypto.getRandomValues(new Uint8Array(64)), { role: "recovery" });
    await wallet.settings.setPaired(
      "recovery",
      { schemeId: SCHEME_ID, pk: toHex(recovery.publicKey), payer: "0x00000000000000000000000000000000000000fb", at: Date.now() },
      Date.now(),
    );
    const usdc = dep.tokens.find((t) => t.symbol === "USDC")!;
    await wallet.handleUi("setup:setTokens", {
      chainId: CHAIN,
      tokens: [{ token: usdc.address, usd: 1, decimals: usdc.decimals, symbol: "USDC" }],
    });
    const status = await wallet.handleUi("account:computePlan", { chainId: CHAIN });
    expect(status.backend).toBe("4337");
    const plan = (await wallet.plans.get(CHAIN))!;
    expect(plan.backend).toBe("4337");
    expect(await pub.getCode({ address: plan.address })).toBeUndefined();

    // Activate: the fee tank creates the MSA with the three modules.
    await fund(status.tank, parseEther("1"));
    await wallet.handleUi("account:activate", { chainId: CHAIN });
    await until(async () => ((await pub.getCode({ address: plan.address })) ? true : undefined));
    const hookTokens = (await pub.readContract({
      address: dep.hook,
      abi: (await import("../../src/generated/contracts")).policyHookAbi,
      functionName: "getToken",
      args: [plan.address, usdc.address],
    })) as { allowed: boolean; usdPerToken: bigint };
    expect(hookTokens).toMatchObject({ allowed: true, usdPerToken: 1_000_000n });
    await fund(plan.address, parseEther("2"));

    // Everyday: $30 to a fresh address, through the bundler.
    const fresh = privateKeyToAccount(toHex(crypto.getRandomValues(new Uint8Array(32)))).address;
    const preview = await wallet.handleUi("send:preview", { chainId: CHAIN, to: fresh, valueWei: parseEther("0.01").toString() });
    expect(preview.route.route).toBe("hot");
    expect(preview.backend).toBe("4337");
    const entry = await wallet.handleUi("send:submit", { chainId: CHAIN, to: fresh, valueWei: parseEther("0.01").toString() });
    expect(entry.backend).toBe("4337");
    const done = await until(async () => {
      await wallet.payments!.refreshPending();
      const e = await wallet.activity.get(entry.id);
      return e?.status === "confirming" ? undefined : e;
    });
    expect(done.status).toBe("confirmed");
    expect(done.txHash).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.01"));
    const after = await wallet.handleUi("account:status", { chainId: CHAIN });
    expect(after.limits.availableUsd).toBe(470);

    // Over the per-payment limit: needs the Vault, nothing sent.
    const big = await wallet.handleUi("send:preview", { chainId: CHAIN, to: fresh, valueWei: parseEther("0.1").toString() });
    expect(big.route.route).toBe("needs-vault");
    expect(big.route.rules).toContain("PER-PAYMENT-LIMIT");

    // The Vault: vaultExec through the executor, the phone's C13 signature over the EIP-712 digest.
    const rec = await wallet.handleUi("vault:create", {
      chainId: CHAIN,
      action: { type: "send", calls: [{ target: fresh, value: parseEther("0.1").toString(), data: "0x" }], usd6: "300000000" },
    });
    expect(rec.path).toBe("direct");
    const req = decodeSignRequest(hexToBytes(rec.cbor));
    expect(req.txType).toBe(TX_TYPE.roleExecutor7579);
    expect(req.verifyingContract).toBe(dep.executor.toLowerCase());
    // The phone's side: recompute the digest from key 4 alone and compare with the executor's own view.
    const { digest } = executorDigest(CHAIN, dep.executor, req.payload);
    const { args } = decodeFunctionData({ abi: roleExecutorAbi, data: req.payload });
    const [account, calls, usdValue, nonce] = args as unknown as [Address, never, bigint, bigint];
    expect(
      await pub.readContract({ address: dep.executor, abi: roleExecutorAbi, functionName: "hashVaultExec", args: [account, nonce, calls, usdValue] }),
    ).toBe(digest);
    const witness = toHex(sign(vault.secretKey, hexToBytes(digest)));
    // A wrong witness is refused before anything is sent.
    const bad = toHex(encodeSignature({ requestId: rec.id, schemeId: SCHEME_ID, witness: toHex(new Uint8Array(3688)) }));
    await expect(wallet.handleUi("vault:submit", { id: rec.id, signature: bad })).rejects.toThrow(/didn't check out/u);
    const good = toHex(encodeSignature({ requestId: rec.id, schemeId: SCHEME_ID, witness }));
    const sent = await wallet.handleUi("vault:submit", { id: rec.id, signature: good });
    expect(sent.status).toBe("sending");
    const confirmed = await until(async () => {
      const r = (await wallet.vault!.refresh()).find((x) => x.id === rec.id);
      return r && r.status !== "sending" ? r : undefined;
    });
    expect(confirmed.status).toBe("confirmed");
    expect(await pub.getBalance({ address: fresh })).toBe(parseEther("0.11"));
  }, 180_000);
});

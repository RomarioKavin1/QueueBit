/**
 * LIVE, on the public devnet (chain 1337): the web wallet's private-balance path, run headless with the same engine
 * (`Wallet` from src/background, its PrivacyController, @queuebit/privacy and the @queuebit/groth16 prover) instead of a
 * browser. Opt-in, it moves real devnet ETH:
 *
 *   QUEUEBIT_LIVE_PRIVACY=1 \
 *   FUNDER_KEY_FILE=/abs/path/contracts/devnet-tests/leanpool-account/.keys/funder.json \
 *   LIVE_STATE=/abs/path/to/state.json \          # the wallet's storage between runs (holds its test words)
 *   VITE_QUEUEBIT_LEANPOOL_URL=http://127.0.0.1:8701 \
 *   pnpm --filter @queuebit/extension exec vitest run test/live
 *
 * 1. a new QueueBit wallet; the funder sends its setup key the creation fee and its account 0.03 ETH;
 * 2. "Make private" 0.02 ETH: an owner payment (LeanPool) of Entrypoint.deposit — it also creates the account;
 * 3. waits for the ASP postman (`bun run asp-auto` in contracts/devnet-tests/privacy) to approve the deposit;
 * 4. "Send privately" 0.01 ETH to a fresh address: proof in-process, a frame tx from a fresh 0-ETH sender, gas paid by
 *    PoolPayerLite out of the withdrawal, sent to the Miner sidecar; mined, and the recipient paid.
 * Each step is resumable from LIVE_STATE. Results are printed as `## live` JSON (tx hashes, amounts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createDefaultProver } from "@queuebit/groth16";
import type { Prover, RagequitProver } from "@queuebit/privacy";
import { createFrameRpc, createLeanPoolClient, httpTransport } from "@queuebit/rpc";
import type { LeanIo } from "../../src/background/lean/account";
import { Wallet } from "../../src/background/wallet";
import { getNetwork } from "../../src/shared/chains";
import { MemoryKV, type KV } from "../../src/shared/kv";

const LIVE = process.env.QUEUEBIT_LIVE_PRIVACY === "1";
const CHAIN = 1337;
const ETH = 10n ** 18n;
const DEPOSIT = (2n * ETH) / 100n;
const SEND = ETH / 100n;
const PW = "live-privacy-test";

/** A KV persisted to one JSON file (the wallet's storage.local between runs). */
class FileKV implements KV {
  private data: Record<string, unknown>;
  constructor(private readonly path: string) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  private flush() {
    const big = (_k: string, x: unknown) => (typeof x === "bigint" ? x.toString() : x);
    writeFileSync(this.path, JSON.stringify(this.data, big), { mode: 0o600 });
  }
  async get<T>(k: string) {
    return this.data[k] === undefined ? undefined : (structuredClone(this.data[k]) as T);
  }
  async set<T>(k: string, v: T) {
    this.data[k] = structuredClone(v);
    this.flush();
  }
  async remove(k: string) {
    delete this.data[k];
    this.flush();
  }
}

function io(): { lean: LeanIo; client: PublicClient } {
  const net = getNetwork(CHAIN);
  const client = createPublicClient({ transport: http(net.rpcUrl, { timeout: 30_000, retryCount: 2 }) });
  const frames = createFrameRpc(net.rpcUrl, { timeoutMs: 30_000, sidecarUrl: net.sidecarUrl });
  const leanpool = createLeanPoolClient(httpTransport(net.leanpoolUrl, { timeoutMs: 30_000 }));
  return {
    client,
    lean: {
      publicClient: () => client,
      node: () => frames.node,
      sidecar: () => frames.sidecar,
      leanpool: () => leanpool,
    },
  };
}

/** The withdraw prover over the pinned artifacts (npm @fatsolutions/privacy-pools-core-circuits, as the apps ship). */
function nodeProver(): Prover & RagequitProver {
  const dir = dirname(
    createRequire(import.meta.url).resolve("@fatsolutions/privacy-pools-core-circuits/artifacts/withdraw.vkey"),
  );
  const p = createDefaultProver({ loader: async (n) => new Uint8Array(await readFile(join(dir, n))) });
  return {
    prove: (i) => p.prove(i),
    proveRagequit: async () => {
      throw new Error("not used");
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (title: string, v: unknown) =>
  console.log(`\n## live ${title}\n${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)}`);

/** A legacy transfer from the funder (fresh `pending` nonce each time: the ASP postman uses the same key). */
async function fund(client: PublicClient, to: Address, value: bigint): Promise<Hex> {
  const file = process.env.FUNDER_KEY_FILE;
  if (!file) throw new Error("set FUNDER_KEY_FILE");
  const key = JSON.parse(readFileSync(file, "utf8"))[0]?.private_key as Hex;
  const acct = privateKeyToAccount(key);
  const gas = ((await client.estimateGas({ account: acct.address, to, value })) * 5n) / 4n;
  for (let attempt = 0; ; attempt++) {
    const nonce = await client.getTransactionCount({ address: acct.address, blockTag: "pending" });
    const raw = await acct.signTransaction({
      type: "legacy",
      chainId: CHAIN,
      nonce,
      gas,
      gasPrice: 2_000_000n,
      to,
      value,
    });
    try {
      const hash = await client.request({ method: "eth_sendRawTransaction", params: [raw] });
      const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1500 });
      if (r.status !== "success") throw new Error(`funding reverted: ${hash}`);
      return hash;
    } catch (e) {
      if (attempt < 3 && /nonce|underpriced|already known/iu.test(String((e as Error).message))) {
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
}

describe.skipIf(!LIVE)("LIVE public devnet: Make private, then Send privately", () => {
  it(
    "deposit as an owner payment, auto-approval, a private send from a fresh 0-ETH address",
    async () => {
      const statePath = process.env.LIVE_STATE;
      if (!statePath) throw new Error("set LIVE_STATE");
      const local = new FileKV(statePath);
      const { lean, client } = io();
      const wallet = new Wallet({
        local,
        session: new MemoryKV(),
        windows: { open: async () => 1, focus: async () => true, exists: async () => true },
        readRpc: (_c, method, params) => client.request({ method: method as never, params: params as never }),
        getBalance: (_c, address) => client.getBalance({ address }),
        io: lean,
        emit: () => undefined,
        prover: nodeProver,
      });
      const ui = wallet.handleUi.bind(wallet) as (t: string, p?: unknown) => Promise<never>;
      const out: Record<string, unknown> = (await local.get("live:out")) ?? {};
      const save = (k: string, v: unknown) => ((out[k] = v), local.set("live:out", out));

      if (!(await wallet.keyring.isInitialized())) {
        await ui("keyring:import", { mnemonic: generateMnemonic(english, 256), password: PW });
      } else await ui("keyring:unlock", { password: PW });
      let st = (await ui("account:status", { chainId: CHAIN })) as {
        address: Address;
        deployed: boolean;
        setupKey: Address;
        setupWei: string;
        activationCostWei: string;
        accountWei: string;
      };
      log("account", { address: st.address, deployed: st.deployed, setupKey: st.setupKey });

      // 1. funding (the funder plays "Test ETH")
      if (!st.deployed && BigInt(st.setupWei) < BigInt(st.activationCostWei)) {
        const need = (BigInt(st.activationCostWei) * 3n) / 2n;
        await save("fundSetupTx", await fund(client, st.setupKey, need));
      }
      const prior = (await wallet.privacy!.view(CHAIN)).op;
      if (BigInt(st.accountWei) < DEPOSIT + ETH / 100n && !out.depositDone && !prior) {
        await save("fundAccountTx", await fund(client, st.address, DEPOSIT + ETH / 100n - BigInt(st.accountWei)));
      }

      // 2. Make private: an owner payment of Entrypoint.deposit (the first payment also creates the account)
      const view = () => wallet.privacy!.view(CHAIN);
      if (!out.depositDone) {
        const v0 = await view();
        expect(v0.availability).toEqual({ ok: true });
        if (!v0.op || v0.op.kind !== "shield" || v0.op.step === "failed")
          await ui("privacy:start", { chainId: CHAIN, kind: "shield", amountWei: DEPOSIT.toString() });
        await wallet.privacy!.run(CHAIN);
        const v = await view();
        log("deposit op", v.op);
        expect(v.op?.kind).toBe("shield");
        expect(v.op?.step).toBe("done");
        const act = await wallet.activity.get(v.op!.deposit!.activityId!);
        await save("deposit", {
          valueWei: DEPOSIT.toString(),
          depositTx: v.op!.deposit!.txHash,
          leanpoolId: act?.hash,
          activationTx: (await wallet.account!.record(CHAIN))?.activation?.hash,
        });
        await save("depositDone", true);
      }
      st = (await ui("account:status", { chainId: CHAIN })) as typeof st;
      expect(st.deployed).toBe(true);

      // 3. the ASP postman (asp-auto) approves it: "getting ready" → ready
      const t0 = Date.now();
      let v = await wallet.privacy!.sync(CHAIN);
      while (BigInt(v.approvedWei) < SEND && Date.now() - t0 < 600_000) {
        log("waiting for approval", { approvedWei: v.approvedWei, pendingWei: v.pendingWei });
        await sleep(15_000);
        v = await wallet.privacy!.sync(CHAIN);
      }
      expect(BigInt(v.approvedWei)).toBeGreaterThanOrEqual(SEND);
      await save("approvedAfterMs", Date.now() - t0);

      // 4. Send privately to a fresh address
      if (!out.sendDone) {
        const to = (out.recipient as Address | undefined) ?? privateKeyToAccount(generatePrivateKey()).address;
        await save("recipient", to);
        const before = await client.getBalance({ address: to });
        const cur = await view();
        if (!cur.op || cur.op.kind !== "unshield" || cur.op.step === "failed")
          await ui("privacy:start", { chainId: CHAIN, kind: "unshield", amountWei: SEND.toString(), to });
        await wallet.privacy!.run(CHAIN);
        const w = await view();
        log("withdrawal op", w.op);
        expect(w.op?.step).toBe("done");
        const sender = w.op!.withdraw!.recipient!; // the fresh one-time sender
        const r = await client.getTransactionReceipt({ hash: w.op!.withdraw!.hash! });
        const after = await client.getBalance({ address: to });
        await save("withdrawal", {
          tx: w.op!.withdraw!.hash,
          block: r.blockNumber,
          status: r.status,
          gasUsed: r.gasUsed,
          sender,
          senderBalanceAfter: await client.getBalance({ address: sender }),
          senderNonceAfter: await client.getTransactionCount({ address: sender }),
          recipient: to,
          recipientReceived: after - before,
          feeWei: w.op!.withdraw!.feeWei,
          receivedWei: w.op!.withdraw!.receivedWei,
          provedMs: w.op!.withdraw!.provedMs,
        });
        expect(after - before).toBe(BigInt(w.op!.withdraw!.receivedWei!));
        await save("sendDone", true);
      }
      const end = await view();
      log("result", { ...out, privateApprovedWei: end.approvedWei, privatePendingWei: end.pendingWei });
    },
    40 * 60_000,
  );
});

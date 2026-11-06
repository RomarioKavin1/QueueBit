// Integration test on the LOCAL devnet (devnet/README.md; `cd devnet && ./up.sh`, then `cd contracts && forge build`):
//
//   LIVE_DEVNET=1 pnpm --filter @leaked/watcher test
//
// Funds from anvil #9 only (README "Funding-key allocation": watcher / misc). Reuses the CREATE2 deployment recorded in
// devnet/deploy/addresses.local.json when its code is on chain and its init code matches the current artifacts;
// otherwise deploys LeakedAccountRoles / LeakedAccountImpl / AccountFactory itself (the contracts/devnet-tests/account
// recipe). Then creates an account (the Vault and the Guardian are stand-in EOAs: role calls authenticate by
// msg.sender), starts the watcher service in-process against the node, and performs:
//   1. a hot payment within the daily limit (no alert),
//   2. an over-limit hot payment: admitted (declared <= per-payment limit), the SENDER frame reverts OverCap, no log,
//   3. a Vault-queued loosening (raise the daily limit),
//   4. a Guardian pause,
// and asserts that the SSE stream and the HMAC webhook deliver the expected alerts within N blocks.
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { encodeTx, getProfile, hotSpendTx, signTx } from "@leaked/frames";
import { createFrameRpc } from "@leaked/rpc";
import { authHeader, verifyAlert, verifyWebhook, type Alert, type SignedAlert } from "@leaked/watcher-core";
import { parseConfig } from "../src/config.js";
import { createService, type Service } from "../src/service.js";

const LIVE = process.env.LIVE_DEVNET === "1";
const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
const CHAIN_ID = 1337;
/** anvil #9: the watcher workstream's funding key (devnet/README.md). Public test key, never real. */
const FUNDER_KEY: Hex = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const CONFIRMATIONS = 1;
/** Alerts must arrive within this many blocks of the action's block. */
const WITHIN_BLOCKS = 6;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "contracts", "out");
const USD = 1_000_000n;
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const profile = getProfile("ethrex-eip8141-tracer");

const chain = {
  id: CHAIN_ID,
  name: "leaked-devnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETHREX] } },
} as const;
const pub = createPublicClient({ chain, transport: http(ETHREX) });
const rpc = createFrameRpc(ETHREX);
const funder = privateKeyToAccount(FUNDER_KEY);

const art = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

async function legacy(from: PrivateKeyAccount, tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) {
  const nonce = await pub.getTransactionCount({ address: from.address, blockTag: "pending" });
  const signed = await from.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce,
    gasPrice: 2_000_000_000n,
    gas: tx.gas ?? 250_000n,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  const hash = await rpc.node.sendRawTransaction(signed);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`tx reverted ${hash}`);
  return r;
}

async function waitFrameReceipt(hash: Hex) {
  for (let i = 0; i < 120; i++) {
    const r = await rpc.node.getTransactionReceipt(hash).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`timeout ${hash}`);
}

/** The recorded CREATE2 deployment, if it is on chain and built from the current artifacts. */
async function reusableDeployment(
  rolesA: ReturnType<typeof art>,
  implA: ReturnType<typeof art>,
  factA: ReturnType<typeof art>,
) {
  const file = join(ROOT, "devnet", "deploy", "addresses.local.json");
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (d.network?.chainId !== CHAIN_ID) return null;
  const c = d.contracts;
  const checks: [ReturnType<typeof art>, { address: Address; args: unknown[]; initCodeHash: Hex }][] = [
    [rolesA, c.LeakedAccountRoles],
    [implA, c.LeakedAccountImpl],
    [factA, c.AccountFactory],
  ];
  for (const [a, rec] of checks) {
    if (!rec) return null;
    const init = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: rec.args as never });
    if (keccak256(init) !== rec.initCodeHash) return null;
    const code = await pub.getCode({ address: rec.address });
    if (!code || code === "0x") return null;
  }
  return {
    roles: c.LeakedAccountRoles.address as Address,
    impl: c.LeakedAccountImpl.address as Address,
    factory: c.AccountFactory.address as Address,
  };
}

type AbiParam = { name?: string; type: string; components?: readonly AbiParam[] };

/** The zero value of an ABI parameter (nested tuples included). */
function zeroOf(p: AbiParam): unknown {
  if (p.type === "tuple") return Object.fromEntries((p.components ?? []).map((c) => [c.name, zeroOf(c)]));
  if (p.type.endsWith("]")) return [];
  if (p.type === "address") return "0x0000000000000000000000000000000000000000";
  if (p.type === "bool") return false;
  if (p.type === "string") return "";
  if (p.type.startsWith("bytes")) return p.type === "bytes" ? "0x" : `0x${"0".repeat(2 * Number(p.type.slice(5)))}`;
  return 0n;
}

/** `initialize`'s `InitConfig` from the artifact, with `known` fields set and every other field at its zero value. */
function initConfig(abi: Abi, known: Record<string, unknown>): Record<string, unknown> {
  const fn = abi.find((x) => x.type === "function" && x.name === "initialize") as
    { inputs: readonly AbiParam[] } | undefined;
  const cfg = fn?.inputs[0];
  if (!cfg || cfg.type !== "tuple") throw new Error("initialize(InitConfig) not in the artifact");
  const out = zeroOf(cfg) as Record<string, unknown>;
  for (const [k, v] of Object.entries(known)) {
    if (!(k in out)) throw new Error(`InitConfig has no field "${k}" any more: update the watcher devnet test`);
    out[k] = v;
  }
  return out;
}

async function deploy(a: ReturnType<typeof art>, args: unknown[], gas: bigint): Promise<Address> {
  const r = await legacy(funder, {
    data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: args as never }),
    gas,
  });
  return r.contractAddress!;
}

const devnetUp = async () => {
  try {
    return (await rpc.node.chainId()) === BigInt(CHAIN_ID) && existsSync(join(OUT, "LeakedAccountImpl.sol"));
  } catch {
    return false;
  }
};

describe.skipIf(!LIVE)("watcher on the local devnet", () => {
  let svc: Service | undefined;
  const servers: Server[] = [];
  afterAll(async () => {
    await svc?.stop();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  });

  it("alerts on a Vault-queued loosening, a Guardian pause and an over-limit attempt within N blocks", async () => {
    if (!(await devnetUp())) throw new Error(`no chain-1337 devnet at ${ETHREX} or no contracts/out (forge build)`);
    const rolesA = art("LeakedAccountRoles.sol", "LeakedAccountRoles");
    const implA = art("LeakedAccountImpl.sol", "LeakedAccountImpl");
    const factA = art("AccountFactory.sol", "AccountFactory");
    const accountAbi = [...implA.abi, ...rolesA.abi.filter((x) => x.type === "function")] as Abi;

    // ---------------------------------------------------------------------------- contracts and account ----
    let d = await reusableDeployment(rolesA, implA, factA);
    const reused = d !== null;
    if (!d) {
      const roles = await deploy(rolesA, [], 35_000_000n);
      const impl = await deploy(implA, [0, true, roles], 36_000_000n);
      const factory = await deploy(factA, [], 10_000_000n);
      d = { roles, impl, factory };
    }
    const hotPriv = generatePrivateKey();
    const tankPriv = generatePrivateKey();
    const hot = privateKeyToAccount(hotPriv);
    const tank = privateKeyToAccount(tankPriv);
    const vault = privateKeyToAccount(generatePrivateKey());
    const guardian = privateKeyToAccount(generatePrivateKey());
    const recovery = privateKeyToAccount(generatePrivateKey()).address;
    // `InitConfig` is built from the artifact's own field list: fields this test does not set (e.g. the bound
    // role-signer parameters, the recipient mode) take their zero value, which `initialize` treats as "explicit
    // signer address" / "default", so the test keeps working when the contracts add fields.
    const initData = encodeFunctionData({
      abi: implA.abi,
      functionName: "initialize",
      args: [
        initConfig(implA.abi, {
          hotKey: hot.address,
          vaultSigner: vault.address,
          recoverySigner: recovery,
          tank: tank.address,
          capUsdPerDay: 10n * USD,
          perTxMaxUsd: 8n * USD,
          maxFeeWeiPerTx: parseEther("0.01"),
          maxPriorityFeePerGas: 2_000_000_000n,
          maxHotFrames: 4,
          selfPay: false,
          timelockDelay: 3600,
          timelockThresholdUsd: 100n * USD,
          ethUsdPrice: 3_000n * USD,
        }),
      ],
    });
    const salt = keccak256(stringToHex(`leaked-watcher-devnet-${Date.now()}`));
    const account = (await pub.readContract({
      address: d.factory,
      abi: factA.abi,
      functionName: "predictAccount",
      args: [salt, d.impl, initData],
    })) as Address;
    await legacy(funder, {
      to: d.factory,
      data: encodeFunctionData({ abi: factA.abi, functionName: "createAccount", args: [salt, d.impl, initData] }),
      gas: 10_000_000n,
    });
    for (const [to, value] of [
      [account, parseEther("0.05")],
      [tank.address, parseEther("0.1")],
      [vault.address, parseEther("0.02")],
      [guardian.address, parseEther("0.02")],
    ] as const) {
      await legacy(funder, { to, value });
    }

    // --------------------------------------------------------------------------------- watcher service ----
    const KEY = `0x${"5a".repeat(32)}`;
    const WEBHOOK_KEY = `0x${"6b".repeat(32)}`;
    const hooks: { body: string; sig: string }[] = [];
    const receiver = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        hooks.push({ body: b, sig: String(req.headers["x-leaked-signature"]) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    servers.push(receiver);

    const startBlock = await pub.getBlockNumber();
    const cfg = parseConfig({
      rpcUrl: ETHREX,
      chainId: CHAIN_ID,
      confirmations: CONFIRMATIONS,
      pollIntervalMs: 1000,
      startBlock: startBlock.toString(),
      accounts: [{ address: account, backend: "frame" }],
      store: `file:${join(mkdtempSync(join(tmpdir(), "leaked-watcher-")), "state.json")}`,
      http: { host: "127.0.0.1", port: 0, trustProxy: 0 },
      apiKeys: [{ id: "ext", secret: KEY }],
      webhook: {
        url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`,
        secret: WEBHOOK_KEY,
        minSeverity: "info",
      },
    });
    svc = await createService(cfg, { log: () => {} });
    await svc.start();

    const streamed: (SignedAlert & { seq: number; type: string })[] = [];
    const res = await fetch(`http://127.0.0.1:${svc.port()}/v1/stream`, {
      headers: { authorization: await authHeader("ext", KEY, "GET", "/v1/stream") },
    });
    expect(res.status).toBe(200);
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf
            .slice(0, i)
            .split("\n")
            .find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (line) streamed.push(JSON.parse(line.slice(6)));
        }
      }
    })();

    // --------------------------------------------------------------------------------------- actions ----
    type Call = { target: Address; value: bigint; data: Hex };
    const hotTx = async (declaredUsd: bigint, calls: Call[]) => {
      const nonceSeq = await rpc.node.getTransactionCount(account, "latest");
      let t = hotSpendTx(profile, {
        chainId: CHAIN_ID,
        nonceSeq,
        fees: FEES,
        account,
        hotKey: hot.address,
        tank: tank.address,
        verifyGas: 80_000n,
        tankGas: 10_000n,
        body: {
          data: encodeFunctionData({ abi: implA.abi, functionName: "hotExecute", args: [declaredUsd, calls] }),
          execution: 300_000n,
          state: 200_000n,
        },
      });
      t = await signTx(profile, t, hotPriv, 0);
      t = await signTx(profile, t, tankPriv, 1);
      return waitFrameReceipt(await rpc.node.sendRawTransaction(encodeTx(profile, t)));
    };
    const blocks: Record<string, bigint> = {};

    // 1. within the limit ($3 tank top-up), then 2. over the limit ($7.80 > ~$7 left; <= $8 per payment)
    const ok = await hotTx(3n * USD, [{ target: tank.address, value: parseEther("0.001"), data: "0x" }]);
    expect(ok.frameReceipts[2]?.status).toBe("success");
    const over = await hotTx(7_800_000n, [{ target: tank.address, value: parseEther("0.0026"), data: "0x" }]);
    expect(over.frameReceipts[2]?.status).toBe("reverted");
    expect(over.frameReceipts[2]?.logs).toEqual([]);
    blocks.overLimit = over.blockNumber!;

    // 3. the Vault queues a loosening (raise the daily limit to $20)
    const setCap = encodeFunctionData({
      abi: accountAbi,
      functionName: "vaultSetCap",
      args: [20n * USD, 8n * USD, parseEther("0.01"), 4],
    });
    const q = await legacy(vault, {
      to: account,
      data: encodeFunctionData({
        abi: accountAbi,
        functionName: "vaultQueue",
        args: [[{ target: account, value: 0n, data: setCap }], 1],
      }),
      gas: 1_000_000n,
    });
    blocks.queued = q.blockNumber;

    // 4. a Guardian pause
    await legacy(vault, {
      to: account,
      data: encodeFunctionData({ abi: accountAbi, functionName: "vaultSetGuardian", args: [guardian.address, true] }),
      gas: 1_000_000n,
    });
    const f = await legacy(guardian, {
      to: account,
      data: encodeFunctionData({ abi: accountAbi, functionName: "guardianFreeze" }),
      gas: 1_000_000n,
    });
    blocks.paused = f.blockNumber;

    // ---------------------------------------------------------------------------------------- expect ----
    const want = ["payment-blocked", "change-scheduled", "guardian-changed", "paused"];
    const seenAt: Record<string, bigint> = {};
    const deadline = blocks.paused + BigInt(WITHIN_BLOCKS);
    while ((await pub.getBlockNumber()) <= deadline + 1n) {
      for (const s of streamed) seenAt[s.alert.kind] ??= await pub.getBlockNumber();
      if (want.every((k) => k in seenAt)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const byKind = new Map<string, Alert>(streamed.map((s) => [s.alert.kind, s.alert]));
    expect([...byKind.keys()].sort()).toEqual([...want].sort());

    expect(byKind.get("payment-blocked")).toMatchObject({
      severity: "warning",
      title: "Over the limit: payment blocked",
      ref: { reason: "over-limit", txHash: over.transactionHash },
    });
    expect(byKind.get("change-scheduled")).toMatchObject({ severity: "urgent", ref: { queueKind: "loosen" } });
    expect(byKind.get("paused")).toMatchObject({ severity: "warning", title: "Paused by your Guardian" });
    for (const [kind, action] of [
      ["payment-blocked", "overLimit"],
      ["change-scheduled", "queued"],
      ["paused", "paused"],
    ] as const) {
      expect(seenAt[kind]! - blocks[action]!, `${kind} latency in blocks`).toBeLessThanOrEqual(BigInt(WITHIN_BLOCKS));
    }

    // Every streamed envelope verifies with the extension's key; the webhook bodies verify with the webhook key.
    for (const s of streamed) expect(await verifyAlert(KEY, s)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(hooks.length).toBeGreaterThanOrEqual(want.length);
    for (const h of hooks) expect(await verifyWebhook(WEBHOOK_KEY, h.body, h.sig)).toBe(true);
    // No amounts or addresses in any title/body.
    for (const a of byKind.values()) expect(`${a.title} ${a.body}`).not.toMatch(/0x[0-9a-f]{6}|\$/i);

    // Deadlines: the queued loosening is tracked for its eta (1 h waiting period).
    expect(
      svc.poller.watcher
        .deadlines()
        .map((x) => x.kind)
        .sort(),
    ).toEqual(["freeze", "op"]);

    console.log(
      JSON.stringify(
        {
          reused,
          account,
          blocks: Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.toString()])),
          alerts: [...byKind.keys()],
        },
        null,
        2,
      ),
    );
  }, 420_000);
});

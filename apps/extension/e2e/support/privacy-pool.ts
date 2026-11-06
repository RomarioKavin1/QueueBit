import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NATIVE_ASSET, POOL_ABI, rootOf } from "@queuebit/privacy";

/**
 * The extension privacy e2e's pool (devnet-only operator stand-in): the real Privacy Pools v1 contracts (vendored
 * 0xbow sources, built by forge into contracts/out), the devnet-test commitment verifier as its ragequit verifier
 * (`contracts/test/privacy/CommitmentGroth16Verifier.sol`), and PoolPayer, deployed exactly as
 * `contracts/devnet-tests/privacy` and the `@queuebit/privacy` devnet e2e do. Funding: one top-up from anvil #5 (the
 * privacy workstream's key) to this suite's own sub-account, which then deploys, stakes PoolPayer and acts as the
 * pool's reviewer (the ASP postman: `updateRoot`). The deployment is cached and reused while its code is on chain.
 */

const RPC = "http://localhost:8545";
const REGISTRY: Address = "0x8464135c8F25Da09e49BC8782676a84730C318bC";
/** anvil #5 (public test key): the privacy workstream's funding key (devnet/README.md). */
const ANVIL5: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
/** This suite's sub-account of anvil #5 (a public, derived test key). */
export const POSTMAN: Hex = keccak256(stringToHex("queuebit/extension-e2e-privacy/v1"));
// This file runs bundled from node_modules/.cache: find the repository root from wherever it runs.
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(d, "pnpm-workspace.yaml"))) {
    const up = dirname(d);
    if (up === d) throw new Error("repository root not found");
    d = up;
  }
  return d;
}
const ROOT = repoRoot();
const OUT = join(ROOT, "contracts", "out") + "/";
const CACHE = join(ROOT, "apps", "extension", "node_modules", ".cache", "queuebit-extension-e2e", "privacy-pool.json");
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const E = 10n ** 18n;

const pub = createPublicClient({ transport: http(RPC, { timeout: 60_000 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PoolDeployment {
  entrypoint: Address;
  pool: Address;
  poolPayer: Address;
  deployBlock: string;
  /** The pool's RAGEQUIT_VERIFIER: the commitment-circuit verifier (devnet-test contract), so a public exit verifies. */
  ragequitVerifier: Address;
}

function artifact(name: string) {
  const j = JSON.parse(readFileSync(`${OUT}${name}.sol/${name}.json`, "utf8"));
  return {
    abi: j.abi as Abi,
    bytecode: j.bytecode.object as Hex,
    links: (j.bytecode.linkReferences ?? {}) as Record<string, Record<string, { start: number; length: number }[]>>,
  };
}

export const artifactsReady = () =>
  existsSync(`${OUT}PoolPayer.sol/PoolPayer.json`) &&
  existsSync(`${OUT}CommitmentGroth16Verifier.sol/CommitmentGroth16Verifier.json`);

const nonces = new Map<Address, number>();
async function send(key: Hex, to: Address | null, data: Hex = "0x", value = 0n, gas?: bigint) {
  const a = privateKeyToAccount(key);
  if (gas === undefined) {
    const est = await pub.estimateGas({ account: a.address, ...(to ? { to } : {}), data, value });
    const block = await pub.getBlock({ blockTag: "latest" });
    const cap = block.gasLimit - 2_000_000n;
    gas = (est * 5n) / 4n > cap ? cap : (est * 5n) / 4n;
  }
  const nonce = nonces.get(a.address) ?? (await pub.getTransactionCount({ address: a.address, blockTag: "pending" }));
  nonces.set(a.address, nonce + 1);
  const raw = await a.signTransaction({
    type: "legacy",
    chainId: 1337,
    nonce,
    gasPrice: 2_000_000_000n,
    gas,
    ...(to ? { to } : {}),
    data,
    value,
  });
  const hash = await pub.sendRawTransaction({ serializedTransaction: raw });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
}

async function deploy(name: string, args: unknown[] = [], libs: Record<string, Address> = {}) {
  const a = artifact(name);
  let code = a.bytecode.slice(2);
  for (const f of Object.values(a.links))
    for (const [lib, refs] of Object.entries(f))
      for (const { start, length } of refs)
        code = code.slice(0, start * 2) + libs[lib]!.slice(2).toLowerCase() + code.slice((start + length) * 2);
  const r = await send(POSTMAN, null, encodeDeployData({ abi: a.abi, bytecode: `0x${code}`, args } as never));
  return { address: r.contractAddress!, block: r.blockNumber };
}

const call = (abi: Abi, functionName: string, args: unknown[] = []) =>
  encodeFunctionData({ abi, functionName, args } as never);

const hasCode = async (a: Address) => ((await pub.getCode({ address: a })) ?? "0x") !== "0x";

/** The pool for this run: reused from the cache when its contracts are still on chain, else deployed (≈ 1 min). */
export async function ensurePool(): Promise<PoolDeployment> {
  if (existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, "utf8")) as PoolDeployment;
    if (
      c.ragequitVerifier &&
      (await hasCode(c.entrypoint)) &&
      (await hasCode(c.pool)) &&
      (await hasCode(c.poolPayer)) &&
      (await hasCode(c.ragequitVerifier))
    )
      return c;
  }
  const sub = privateKeyToAccount(POSTMAN).address;
  const bal = await pub.getBalance({ address: sub });
  if (bal < 2n * E) await send(ANVIL5, sub, "0x", 4n * E - bal, 250_000n);

  const verifier = await deploy("WithdrawalGroth16Verifier");
  const t3 = await deploy("PoseidonT3");
  const t4 = await deploy("PoseidonT4");
  const impl = await deploy("Entrypoint");
  const ep = artifact("Entrypoint").abi;
  const proxy = await deploy("ERC1967Proxy", [impl.address, call(ep, "initialize", [sub, sub])]);
  // Deployed after the Entrypoint so that it keeps its nonce-4 address on a fresh devnet (the companion registry).
  const commitment = await deploy("CommitmentGroth16Verifier");
  const pool = await deploy("PrivacyPoolSimple", [proxy.address, verifier.address, commitment.address], {
    PoseidonT3: t3.address,
    PoseidonT4: t4.address,
  });
  await send(POSTMAN, proxy.address, call(ep, "registerPool", [NATIVE_ASSET, pool.address, 0n, 0n, 0n]));
  const payer = await deploy("PoolPayer", [
    {
      devnet: 0,
      entrypoint: proxy.address,
      pool: pool.address,
      registry: REGISTRY,
      operator: sub,
      feeParam: 6,
      // Calibrated lower-bound estimator (IMPLEMENTATION-NOTES, PoolPayer after the security review).
      intrinsicGas: 21_000n,
      perFrameGas: 0n,
      gasPerDataByte: 4n,
      refundFrameGas: 23_000n,
      valueFrameGas: 0n,
      minPayStateGas: 183_600n,
      minSettleGas: 1_000_000n,
      minSettleStateGas: 1_000_000n,
      minRefundGas: 150_000n,
      minRefundStateGas: 183_600n,
    },
  ]);
  await send(POSTMAN, payer.address, "0x", E / 2n, 100_000n);
  await send(POSTMAN, payer.address, call(artifact("PoolPayer").abi, "stake", [86_400]), 12n * 10n ** 15n, 500_000n);
  const d: PoolDeployment = {
    entrypoint: proxy.address,
    pool: pool.address,
    poolPayer: payer.address,
    deployBlock: pool.block.toString(),
    ragequitVerifier: commitment.address,
  };
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(d, null, 2));
  return d;
}

/** The pool's deposit labels, in deposit order. */
export async function depositLabels(d: PoolDeployment): Promise<bigint[]> {
  const logs = await pub.getLogs({ address: d.pool, fromBlock: BigInt(d.deployBlock), toBlock: "latest" });
  const out: bigint[] = [];
  for (const l of logs) {
    try {
      const e = decodeEventLog({ abi: POOL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (e.eventName === "Deposited") out.push((e.args as unknown as { _label: bigint })._label);
    } catch {
      // another event
    }
  }
  return out;
}

/** The reviewer (ASP postman) approves every deposit made so far, in pool order. */
export async function approveAllDeposits(d: PoolDeployment): Promise<{ labels: number; root: bigint }> {
  const labels = await depositLabels(d);
  const root = rootOf(labels);
  await send(POSTMAN, d.entrypoint, call(artifact("Entrypoint").abi, "updateRoot", [root, CID]));
  // The node's view of the new root: the extension re-syncs right after.
  await sleep(1000);
  return { labels: labels.length, root };
}

export async function balanceOf(a: Address): Promise<bigint> {
  return pub.getBalance({ address: a });
}

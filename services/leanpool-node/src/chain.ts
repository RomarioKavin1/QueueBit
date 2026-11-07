// The node's view of the chain (Chain8288): key binding, root posts, proof hashes, delivery to the alt mempool.
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
} from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { profile, toWire, txHash, type FrameTx } from "./frameTx.js";
import type { Chain8288 } from "./node.js";
import { AdmittedButPending } from "./node.js";
import type { NodeConfig } from "./config.js";

export const REGISTRY_ABI = parseAbi([
  "function minBond() view returns (uint256)",
  "function bonds(address) view returns (uint256)",
  "function bond() payable",
  "function postRoot(bytes32 root, uint16 count, address[] wallets) returns (uint8 ring)",
  "function attachProof(bytes32 root, bytes32 proofHash)",
  "function rootAt(address aggregator, address wallet, uint8 i) view returns (bytes32)",
  "function batches(address aggregator, bytes32 root) view returns (uint64 postedAt, uint16 count, bool posted, bytes32 proofHash)",
  "event RootPosted(bytes32 indexed root, address indexed aggregator, uint16 count, uint8 ring)",
  "event ProofAttached(bytes32 indexed root, address indexed aggregator, bytes32 proofHash)",
]);
/** A single-dependency sender's key, read from its `vk()` (LeanPool `LeanWallet8288`-style senders). */
const SENDER_ABI = parseAbi(["function vk() view returns (bytes32)", "function aggregator() view returns (address)"]);
const KEYSTORE_ABI = parseAbi([
  "function getKey(address account, bytes32 keyId) view returns ((uint8 kind, uint8 weight, uint8 roles, uint48 validUntil, uint128 perTxCap, bytes32 a, bytes32 b))",
]);
const KIND_PQ = 1;
const keyIdOf = (kind: number, a: Hex, b: Hex = pad("0x", { size: 32 })) =>
  keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [kind, a, b]));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function jsonRpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 30_000,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }, (_k, v) => (typeof v === "bigint" ? toHex(v) : v)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result as T;
}

/** The ring position from DepsRegistry's RootPosted event in a postRoot receipt: it goes into each tx's witness. */
export function ringOf(logs: { data: Hex; topics: Hex[] }[]): number {
  for (const l of logs) {
    try {
      const e = decodeEventLog({ abi: REGISTRY_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (e.eventName === "RootPosted") return Number(e.args.ring);
    } catch {
      // another event
    }
  }
  throw new Error("no RootPosted event in the receipt");
}

const NONCE_MANAGER = profile.predeploys!.NONCE_MANAGER as Address;

export interface NodeChain {
  chain: Chain8288;
  keyedNonce(sender: Address, nonceKey: bigint): Promise<bigint>;
  ensureBond(): Promise<{ bonded: bigint; min: bigint }>;
  address: Address;
}

export function makeChain(cfg: NodeConfig, log: (...a: unknown[]) => void): NodeChain {
  const chain = defineChain({
    id: cfg.chainId,
    name: "leanpool-chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const account = privateKeyToAccount(cfg.privateKey);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl, { timeout: 30_000 }) });
  const wallet = createWalletClient({ chain, account, transport: http(cfg.rpcUrl, { timeout: 30_000 }) });

  /** Legacy tx; new storage slots cost extra state gas on the devnet's resource-based model: estimate, add 30%. */
  async function sendLegacy(tx: { to: Address; data: Hex; value?: bigint }) {
    const est = await pub.estimateGas({ account: account.address, ...tx });
    const hash = await wallet.sendTransaction({
      ...tx,
      gas: (est * 13n) / 10n,
      gasPrice: cfg.legacyGasPrice,
      type: "legacy",
    });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
    return r;
  }

  async function waitFrameReceipt(hash: Hex, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await jsonRpc(cfg.rpcUrl, "eth_getTransactionReceipt", [hash]).catch(() => null);
      if (r) return r as { status: Hex; gasUsed: Hex; blockNumber: Hex };
      await sleep(2000);
    }
    throw new Error(`tx ${hash} not mined within ${timeoutMs / 1000}s`);
  }

  /** EIP-8250: next `nonce_seq` of (account, key). Key 0 is the account nonce. */
  async function keyedNonce(sender: Address, nonceKey: bigint): Promise<bigint> {
    if (nonceKey === 0n) return BigInt(await pub.getTransactionCount({ address: sender }));
    const slot = keccak256(concat([pad(sender), toHex(nonceKey, { size: 32 })]));
    return BigInt((await pub.getStorageAt({ address: NONCE_MANAGER, slot })) ?? "0x0");
  }

  /** Bonds the aggregator up to the registry's minimum when allowed and needed. */
  async function ensureBond(): Promise<{ bonded: bigint; min: bigint }> {
    const [min, bonded] = await Promise.all([
      pub.readContract({ address: cfg.registry, abi: REGISTRY_ABI, functionName: "minBond" }),
      pub.readContract({ address: cfg.registry, abi: REGISTRY_ABI, functionName: "bonds", args: [account.address] }),
    ]);
    if (bonded >= min || cfg.autoBondWei === 0n) return { bonded, min };
    const value = min - bonded > cfg.autoBondWei ? cfg.autoBondWei : min - bonded;
    await sendLegacy({
      to: cfg.registry,
      data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "bond" }),
      value,
    });
    log(`bonded ${value} wei in ${cfg.registry}`);
    return { bonded: bonded + value, min };
  }

  const c: Chain8288 = {
    async holdsKey(sender: Address, vk: Hex, validator: Address | null) {
      if (!validator) {
        const own = await pub.readContract({ address: sender, abi: SENDER_ABI, functionName: "vk" }).catch(() => null);
        if (!own || own.toLowerCase() !== vk.toLowerCase()) return false;
        // A sender that names its aggregator (`aggregator()`) only accepts roots from it: batching it anywhere else
        // would post a root its VERIFY never reads.
        const agg = await pub
          .readContract({ address: sender, abi: SENDER_ABI, functionName: "aggregator" })
          .catch(() => null);
        return !agg || agg.toLowerCase() === account.address.toLowerCase() || !cfg.aggregate;
      }
      if (!cfg.keystore || validator.toLowerCase() !== cfg.keystore.toLowerCase()) return false;
      const k = await pub
        .readContract({
          address: cfg.keystore,
          abi: KEYSTORE_ABI,
          functionName: "getKey",
          args: [sender, keyIdOf(KIND_PQ, vk)],
        })
        .catch(() => null);
      return (
        k?.kind === KIND_PQ && (Number(k.validUntil) === 0 || Number(k.validUntil) >= Math.floor(Date.now() / 1000))
      );
    },
    async postRoot(root, count, wallets) {
      const r = await sendLegacy({
        to: cfg.registry,
        data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "postRoot", args: [root, count, wallets] }),
      });
      return { tx: r.transactionHash, block: r.blockNumber, ring: ringOf(r.logs) };
    },
    async ringPosition(root, wallets) {
      let at: number | null = null;
      for (const w of wallets) {
        let found: number | null = null;
        for (let i = 0; i < 8; i++) {
          const r = await pub.readContract({
            address: cfg.registry,
            abi: REGISTRY_ABI,
            functionName: "rootAt",
            args: [account.address, w, i],
          });
          if (r.toLowerCase() === root.toLowerCase()) {
            found = i;
            break;
          }
        }
        if (found === null || (at !== null && found !== at)) return null;
        at = found;
      }
      return at;
    },
    async attachProof(root, proofHash) {
      const r = await sendLegacy({
        to: cfg.registry,
        data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "attachProof", args: [root, proofHash] }),
      });
      return r.transactionHash;
    },
    async outcome(hash) {
      const r = (await jsonRpc(cfg.rpcUrl, "eth_getTransactionReceipt", [hash]).catch(() => null)) as {
        status: Hex;
        gasUsed: Hex;
      } | null;
      if (r) return { status: r.status, gasUsed: BigInt(r.gasUsed) };
      const st = (await jsonRpc(cfg.sidecarUrl, "skandha_frameTransactionStatus", [hash]).catch(() => null)) as {
        status?: string;
        reason?: string;
      } | null;
      if (st?.status === "Cancelled" || st?.status === "Reverted") return { dropped: st.reason ?? st.status };
      return null;
    },
    async submit(tx: FrameTx) {
      await jsonRpc(cfg.sidecarUrl, "eth_sendFrameTransaction", [toWire(tx)]); // throws if the sidecar refuses it
      // A short wait: a tx still in the alt mempool after it is followed by the node's follow loop (followPending),
      // so one slow tx doesn't hold up the next batch.
      const r = await waitFrameReceipt(txHash(tx), 45_000).catch((e: Error) => {
        throw new AdmittedButPending(e.message);
      });
      log(`  mined ${txHash(tx)} in block ${BigInt(r.blockNumber)}`);
      return { status: r.status, gasUsed: BigInt(r.gasUsed) };
    },
  };
  return { chain: c, keyedNonce, ensureBond, address: account.address };
}

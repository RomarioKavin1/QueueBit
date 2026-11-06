import { sha256 } from "@noble/hashes/sha2.js";
import { concat, keccak256, pad, parseGwei, toHex, type Address, type Hex } from "viem";
import { vi } from "vitest";
import type { ApprovalWindows } from "../../src/background/approvals";
import type { LeanIo } from "../../src/background/lean/account";
import type { PqKey } from "../../src/background/lean/owner";
import { Wallet } from "../../src/background/wallet";
import { MemoryKV } from "../../src/shared/kv";

export const MNEMONIC = "test test test test test test test test test test test junk";
export const AGGREGATOR = "0x99Bd573ABC2E87D33429856d13712BA82203AF41" as Address;
export const FAST = { N: 2 ** 10, r: 8, p: 1 };

/** A stand-in for the leanSPHINCS WASM key: a 32-byte public key from the seed, fixed-size signatures. */
export const fakePq = (seed: Uint8Array): PqKey => ({
  publicKey: sha256(seed),
  sign: (m) => {
    const sig = new Uint8Array(4276);
    sig.set(m);
    return sig;
  },
  dispose: () => undefined,
});

/** A chain in memory: what the account service reads and sends, recorded. */
export function fakeChain() {
  const code = new Map<string, Hex>();
  const balances = new Map<string, bigint>();
  const legacy: Hex[] = [];
  const pooled: Array<{ raw: Hex; sigs: Hex[]; id: Hex }> = [];
  const frames: unknown[] = [];
  const stages = new Map<string, string>();
  const receipts = new Map<string, "success" | "reverted">();
  const txCount = new Map<string, number>();
  const storage = new Map<string, Hex>();
  /** Knobs: the sidecar refuses frame txs with this message; the LeanPool node reports another address or is down. */
  const knobs: {
    refuseFrames?: string;
    nodeId?: Address;
    leanpoolDown?: boolean;
    sendDelayMs?: number;
    /** A legacy tx (the setup key's createAccount) deploys this address when it is sent. */
    deployOnLegacy?: Address;
  } = {};
  const k = (a: string) => a.toLowerCase();
  const publicClient = {
    getCode: async ({ address }: { address: Address }) => code.get(k(address)),
    getBalance: async ({ address }: { address: Address }) => balances.get(k(address)) ?? 0n,
    getGasPrice: async () => parseGwei("1"),
    getBlock: async () => ({ baseFeePerGas: parseGwei("1") }),
    getTransactionCount: async ({ address }: { address: Address }) => txCount.get(k(address)) ?? 0,
    // EIP-8250 keyed nonces live in the nonce manager at keccak(account ‖ key), as AccountService.nonce reads them.
    getStorageAt: async ({ slot }: { slot: Hex }) => storage.get(slot.toLowerCase()) ?? "0x0",
    estimateGas: async () => 200_000n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      legacy.push(serializedTransaction);
      if (knobs.deployOnLegacy) code.set(k(knobs.deployOnLegacy), "0x6001");
      return keccak256(serializedTransaction);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(k(hash));
      if (!r) throw new Error("not found");
      return { status: r, blockNumber: 5n, gasUsed: 21_000n, effectiveGasPrice: parseGwei("1") };
    },
  };
  const io: LeanIo = {
    publicClient: () => publicClient as never,
    node: () => ({ getTransactionReceipt: async () => null }) as never,
    sidecar: () =>
      ({
        sendFrameTransaction: async (tx: unknown) => {
          if (knobs.sendDelayMs) await new Promise((r) => setTimeout(r, knobs.sendDelayMs));
          if (knobs.refuseFrames) throw new Error(knobs.refuseFrames);
          frames.push(tx);
          return `0x${String(frames.length).padStart(64, "5")}` as Hex;
        },
        frameTransactionStatus: async () => null,
      }) as never,
    leanpool: () =>
      ({
        status: async () => {
          if (knobs.leanpoolDown) throw new Error("connection refused");
          return { name: "test", aggregating: true, nodeId: knobs.nodeId ?? AGGREGATOR, pool: [] };
        },
        sendTransaction: async (raw: Hex, sigs: Hex[]) => {
          const id = keccak256(raw);
          pooled.push({ raw, sigs, id });
          stages.set(id, "pooled");
          return { txHash: id };
        },
        getTx: async (id: Hex) => {
          const stage = stages.get(id);
          return stage ? { stage, ...(stage === "mined" ? { txHash: `0x${"77".repeat(32)}` } : {}) } : null;
        },
      }) as never,
  };
  return {
    io,
    code,
    balances,
    legacy,
    pooled,
    frames,
    stages,
    receipts,
    txCount,
    knobs,
    deploy: (a: Address) => code.set(k(a), "0x6001"),
    fund: (a: Address, wei: bigint) => balances.set(k(a), wei),
    /** The next nonce_seq of (account, key) on a keyed lane (key 0 is txCount). */
    setKeyedNonce: (a: Address, key: bigint, seq: bigint) =>
      storage.set(keccak256(concat([pad(a), toHex(key, { size: 32 })])).toLowerCase(), toHex(seq)),
  };
}

export function windows(): ApprovalWindows & { open: ReturnType<typeof vi.fn>; alive: Set<number> } {
  const alive = new Set<number>();
  let next = 100;
  return {
    alive,
    open: vi.fn(async () => {
      alive.add(++next);
      return next;
    }),
    focus: async (id) => alive.has(id),
    exists: async (id) => alive.has(id),
  };
}

export function makeWallet(
  o: {
    local?: MemoryKV;
    session?: MemoryKV;
    w?: ReturnType<typeof windows>;
    chain?: ReturnType<typeof fakeChain>;
  } = {},
) {
  const local = o.local ?? new MemoryKV();
  const session = o.session ?? new MemoryKV();
  const w = o.w ?? windows();
  const chain = o.chain ?? fakeChain();
  const emit = vi.fn();
  const wallet = new Wallet({
    local,
    session,
    windows: w,
    readRpc: async () => null,
    getBalance: async () => 0n,
    emit,
    io: chain.io,
    pqKey: fakePq,
    keyring: { scrypt: FAST },
  });
  return { wallet, local, session, w, emit, chain };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

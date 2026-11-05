// Shared helpers for the devnet smoke test and probes. Everything is explicit: the ethrex URL, the sidecar URL,
// the codec profile and the dev keys. Uses @forshtat/hegota-support (MIT, vendored in ../vendor) for the
// frame-tx codec and viem for everything else.
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import {
  encodeTx, frame, newTx, secp256k1Placeholder, sigHash, signTx, txHash,
  type Frame, type FrameTx, type SignatureEntry,
} from "@forshtat/hegota-support/tx";
import { rpc, RpcError, toWire } from "@forshtat/hegota-support/rpc";
import {
  createPublicClient, createWalletClient, http, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export { profile, encodeTx, frame, newTx, secp256k1Placeholder, sigHash, signTx, txHash, rpc, RpcError, toWire };
export type { Frame, FrameTx, SignatureEntry };

export const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
export const SIDECAR = process.env.SIDECAR_URL ?? "http://localhost:14337/rpc";
export const CHAIN_ID = 1337;

/** Public, throwaway test keys (anvil/hardhat mnemonic "test test ... junk" and the sidecar repo's devnet key). */
export const KEYS = {
  devnet: "0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15",
  anvil0: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  anvil1: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  anvil2: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  anvil3: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  anvil4: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  anvil5: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  anvil6: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  anvil7: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  anvil8: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  anvil9: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
} as const satisfies Record<string, Hex>;

// local fork default; the public devnet's is 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f (set STAKING_REGISTRY)
export const STAKING_REGISTRY: Address = (process.env.STAKING_REGISTRY as Address) ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC";
export const ENTRY_POINT: Address = "0x00000000000000000000000000000000000000aa";

export const chain = {
  id: CHAIN_ID, name: "leaked-devnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETHREX] } },
} as const;

export const pub = createPublicClient({ chain, transport: http(ETHREX) });
export const wallet = (key: Hex) => createWalletClient({ chain, transport: http(ETHREX), account: privateKeyToAccount(key) });
export const addr = (key: Hex): Address => privateKeyToAccount(key).address;

export const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}` as Hex;

export async function ethrex(method: string, params: unknown[] = []) { return rpc(ETHREX, method, params); }
export async function sidecar(method: string, params: unknown[] = []) { return rpc(SIDECAR, method, params); }

export async function waitReceipt(hash: Hex, timeoutMs = 120_000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ethrex("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for receipt ${hash}`);
}

/** Legacy tx through ethrex (type 0). gas 250k for transfers: a fresh account costs ~204.6k state gas on Amsterdam+. */
export async function sendLegacy(key: Hex, tx: { to: Address | null; data?: Hex; value?: bigint; gas?: bigint }): Promise<Hex> {
  const w = wallet(key);
  const nonce = await pub.getTransactionCount({ address: w.account.address, blockTag: "pending" });
  const signed = await w.account.signTransaction({
    type: "legacy", chainId: CHAIN_ID, nonce, gasPrice: 1_000_000_000n, gas: tx.gas ?? 250_000n,
    to: tx.to ?? undefined, data: tx.data, value: tx.value ?? 0n,
  });
  return ethrex("eth_sendRawTransaction", [signed]);
}

export async function deploy(key: Hex, bytecode: Hex, value = 0n): Promise<{ hash: Hex; address: Address; receipt: any }> {
  const hash = await sendLegacy(key, { to: null, data: bytecode, value, gas: 25_000_000n });
  const receipt = await waitReceipt(hash);
  if (receipt.status !== "0x1") throw new Error(`deploy reverted: ${hash}`);
  return { hash, address: receipt.contractAddress, receipt };
}

export async function frameNonce(sender: Address): Promise<bigint> {
  return BigInt(await ethrex("eth_getTransactionCount", [sender, "latest"]));
}

/** Self-relay shape [VERIFY(EXECUTION_AND_PAYMENT) on sender, SENDER...] signed by `key` as the sender's owner. */
export async function buildSelfRelay(key: Hex, sender: Address, body: Frame[], opts: { verifyGas?: bigint; extraSigs?: SignatureEntry[] } = {}): Promise<FrameTx> {
  const tx = newTx({
    chainId: CHAIN_ID, sender, nonceSeq: await frameNonce(sender),
    fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    signatures: [secp256k1Placeholder(profile, addr(key)), ...(opts.extraSigs ?? [])],  // signer = owner EOA (not tx.sender) when the sender is a contract
    frames: [frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: opts.verifyGas ?? 80_000n }), ...body],
  });
  return signTx(profile, tx, key, 0);
}

export function log(title: string, v: unknown) {
  console.log(`\n## ${title}\n` + (typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)));
}

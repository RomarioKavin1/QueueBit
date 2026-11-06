import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { rpc as libRpc } from "@forshtat/hegota-support/rpc";
import { devnet, local } from "./config.ts";
import { encodeRaw, toWire, profile, type FrameTx } from "./frameTx.ts";
import { concat, keccak256, pad, toHex } from "viem";

export const chain = defineChain({
  id: devnet.chainId,
  name: "altmempool-devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [devnet.ethrexUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(devnet.ethrexUrl, { timeout: 30_000 }) });

export const walletClient = (privateKey: Hex) =>
  createWalletClient({ chain, account: privateKeyToAccount(privateKey), transport: http(devnet.ethrexUrl, { timeout: 30_000 }) });

export const rpc = (method: string, params: unknown[] = [], url = devnet.ethrexUrl): Promise<any> => libRpc(url, method, params);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Legacy tx (deployments, plain calls): the devnet base fee is tiny, the gas price clears it. */
export async function sendLegacy(privateKey: Hex, tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) {
  const w = walletClient(privateKey);
  const hash = await w.sendTransaction({
    to: tx.to ?? null,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: tx.gas ?? 300_000n,
    gasPrice: devnet.legacyGasPrice,
    type: "legacy",
  } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
  return receipt;
}

/** Into the ERC-8421 alt mempool through a sidecar. A LeanPool node passes its own sidecar, which gossips the tx
 * to its libp2p peers (and from there to the block producer's sidecar). */
export const sendFrameTx = (tx: FrameTx, sidecar = local.sidecarA): Promise<Hex> =>
  rpc("eth_sendFrameTransaction", [toWire(tx)], sidecar);

/** Straight to ethrex's canonical mempool. */
export const sendRawCanonical = (tx: FrameTx): Promise<Hex> => rpc("eth_sendRawTransaction", [encodeRaw(tx)], devnet.ethrexUrl);

export interface FrameReceipt {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  frameReceipts?: { status: Hex; gasUsed?: Hex }[];
  [k: string]: unknown;
}

export async function waitFrameReceipt(hash: Hex, timeoutMs = 120_000): Promise<FrameReceipt> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    await sleep(2000);
  }
  throw new Error(`tx ${hash} not mined within ${timeoutMs / 1000}s`);
}

/** EIP-8250: next `nonce_seq` of (account, key). Key 0 is the account nonce; other keys live in NONCE_MANAGER at
 * `keccak256(pad32(account) ‖ uint256(key))` (the workshop's predeploys.ts, verified on the devnet by its step 12). */
export async function keyedNonce(account: Address, nonceKey: bigint): Promise<bigint> {
  if (nonceKey === 0n) return BigInt(await publicClient.getTransactionCount({ address: account }));
  const slot = keccak256(concat([pad(account), toHex(nonceKey, { size: 32 })]));
  const v = await publicClient.getStorageAt({ address: NONCE_MANAGER, slot });
  return BigInt(v ?? "0x0");
}

const NONCE_MANAGER = profile.predeploys!.NONCE_MANAGER as Address;

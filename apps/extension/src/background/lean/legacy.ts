import type { Address, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Ordinary (non-frame) transactions from a secp256k1 key the extension holds: the setup key creating the account or
 * sending a Safe's execTransaction, or a key imported for a move. Gas is estimated and given 20 % headroom.
 */
export interface LegacyCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

export interface LegacyQuote {
  gas: bigint;
  gasPrice: bigint;
  /** gas × gasPrice */
  fee: bigint;
}

export async function quoteLegacy(client: PublicClient, from: Address, call: LegacyCall): Promise<LegacyQuote> {
  const [estimate, gasPrice] = await Promise.all([
    client.estimateGas({ account: from, to: call.to, value: call.value ?? 0n, data: call.data ?? "0x" }),
    client.getGasPrice(),
  ]);
  const gas = (estimate * 12n) / 10n;
  return { gas, gasPrice, fee: gas * gasPrice };
}

export async function sendLegacy(
  client: PublicClient,
  privateKey: Hex,
  chainId: number,
  call: LegacyCall,
  quote?: LegacyQuote,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const q = quote ?? (await quoteLegacy(client, account.address, call));
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const raw = await account.signTransaction({
    type: "legacy",
    chainId,
    nonce,
    to: call.to,
    value: call.value ?? 0n,
    data: call.data ?? "0x",
    gas: q.gas,
    gasPrice: q.gasPrice,
  });
  return client.sendRawTransaction({ serializedTransaction: raw });
}

/**
 * EIP-7702: the EOA delegates to `implementation` and calls itself with `data` in the same transaction (it pays its
 * own fee, so the authorization's nonce is the transaction's + 1).
 */
export async function send7702(
  client: PublicClient,
  privateKey: Hex,
  chainId: number,
  implementation: Address,
  data: Hex,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const [nonce, fees] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    client.estimateFeesPerGas(),
  ]);
  const authorization = await account.signAuthorization({ chainId, address: implementation, nonce: nonce + 1 });
  const gas = 1_500_000n;
  const raw = await account.signTransaction({
    type: "eip7702",
    chainId,
    nonce,
    to: account.address,
    data,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    authorizationList: [authorization],
  });
  return client.sendRawTransaction({ serializedTransaction: raw });
}

/** Waits for an ordinary transaction; true when it succeeded. */
export async function waitLegacy(client: PublicClient, hash: Hex, timeoutMs = 120_000): Promise<boolean> {
  const r = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_500 });
  return r.status === "success";
}

import {
  concat,
  encodeFunctionData,
  encodePacked,
  hexToBigInt,
  size,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { multiSendAbi, safeAbi } from "./abi.js";
import type { Call } from "./tx.js";

/**
 * A Safe (v1.4.1) moves into a LeanAccount in one Safe transaction: a DELEGATECALL into MultiSendCallOnly running the
 * migration's calls (every ERC-20 transfer, then factory.createAccount{value: all ETH}). The owners sign the standard
 * EIP-712 `SafeTx`, exactly what MetaMask shows for any Safe transaction.
 */

export const SAFE_OPERATION = { CALL: 0, DELEGATECALL: 1 } as const;

export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

/** MultiSend's packed batch: per call `uint8 operation ‖ address to ‖ uint256 value ‖ uint256 dataLength ‖ data`. */
export function encodeMultiSend(calls: Call[]): Hex {
  if (calls.length === 0) return "0x"; // viem's concat([]) returns bytes, not hex
  return concat(
    calls.map((c) => {
      const data = c.data ?? "0x";
      return encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [SAFE_OPERATION.CALL, c.to, c.value ?? 0n, BigInt(size(data)), data],
      );
    }),
  );
}

/** The Safe transaction that runs `calls` through MultiSendCallOnly (no refund, no gas token). */
export function multiSendSafeTx(multiSend: Address, calls: Call[], nonce: bigint): SafeTx {
  return {
    to: multiSend,
    value: 0n,
    data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [encodeMultiSend(calls)] }),
    operation: SAFE_OPERATION.DELEGATECALL,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
  };
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The EIP-712 typed data an owner signs (Safe v1.3+/1.4 domain: chainId + verifyingContract). */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: { ...tx },
  };
}

/** Owners' 65-byte EIP-712 signatures, sorted by owner as Safe requires; a v of 0/1 becomes 27/28. */
export function packSafeSignatures(sigs: { owner: Address; signature: Hex }[]): Hex {
  const sorted = [...sigs].sort((a, b) => (hexToBigInt(a.owner) < hexToBigInt(b.owner) ? -1 : 1));
  return concat(
    sorted.map(({ signature }) => {
      if (size(signature) !== 65) throw new Error("a Safe owner signature is 65 bytes (r ‖ s ‖ v)");
      const v = Number(BigInt(`0x${signature.slice(130)}`));
      return v < 27 ? concat([signature.slice(0, 130) as Hex, toHex(v + 27, { size: 1 })]) : signature;
    }),
  );
}

/** The call that executes a signed Safe transaction (anyone may send it; the owners' signatures authorize it). */
export function execTransactionCall(safe: Address, tx: SafeTx, signatures: Hex): Call {
  return {
    to: safe,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: "execTransaction",
      args: [
        tx.to,
        tx.value,
        tx.data,
        tx.operation,
        tx.safeTxGas,
        tx.baseGas,
        tx.gasPrice,
        tx.gasToken,
        tx.refundReceiver,
        signatures,
      ],
    }),
  };
}

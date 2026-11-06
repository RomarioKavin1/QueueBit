import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  maxUint48,
  type Address,
  type Hex,
} from "viem";
import { policyHookAbi, roleExecutorAbi } from "../../generated/contracts";
import type { AaDeployment } from "../../shared/chains";
import { USD } from "../account";
import {
  buildVaultAction,
  KIND,
  type BuiltVaultAction,
  type CurrentPolicy,
  type VaultActionRequest,
} from "../vaultActions";

/**
 * Vault and Recovery approvals on the 4337 backend: a `QueueBitRoleExecutor` call whose PQ signature covers the
 * executor's EIP-712 digest (IMPLEMENTATION-NOTES "Contracts M7"). The request the phone signs is
 * `ur:queuebit-sign-request` tx-type 3: key 4 = the executor calldata with an EMPTY `pqSig`, key 14 = the executor.
 * Config calls target the hook / the executor with the account as first argument; spends go through the account.
 */

export interface ExecCall {
  target: Address;
  value: bigint;
  data: Hex;
}

export type ExecutorFn =
  | "vaultExec"
  | "vaultQueue"
  | "vaultCancel"
  | "recoveryCancel"
  | "recoveryStartVaultRotation"
  | "recoveryCancelVaultRotation";

const CALLS = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

/** `callsHash = keccak256(abi.encode(calls))` (the executor's `callsHash`). */
export const execCallsHash = (calls: readonly ExecCall[]): Hex => keccak256(encodeAbiParameters(CALLS, [calls]));

const domain = (chainId: number, executor: Address) =>
  ({ name: "QueueBitRoleExecutor", version: "1", chainId, verifyingContract: executor }) as const;

/**
 * The EIP-712 digest the role key signs for an (unsigned) executor call, recomputed from the calldata alone: what the
 * phone must show and sign (the companion's tx-type 3 reviewer does the same, BACKLOG). The extension also checks it
 * against the executor's own `hash*` view before showing the code.
 */
export function executorDigest(chainId: number, executor: Address, calldata: Hex): { fn: ExecutorFn; digest: Hex } {
  const { functionName, args } = decodeFunctionData({ abi: roleExecutorAbi, data: calldata });
  const a = args as readonly unknown[];
  const d = domain(chainId, executor);
  switch (functionName) {
    case "vaultExec": {
      const [account, calls, usdValue, nonce] = a as [Address, ExecCall[], bigint, bigint];
      return {
        fn: functionName,
        digest: hashTypedData({
          domain: d,
          types: {
            VaultExec: [
              { name: "account", type: "address" },
              { name: "nonce", type: "uint256" },
              { name: "callsHash", type: "bytes32" },
              { name: "usdValue", type: "uint256" },
            ],
          },
          primaryType: "VaultExec",
          message: { account, nonce, callsHash: execCallsHash(calls), usdValue },
        }),
      };
    }
    case "vaultQueue": {
      const [account, calls, kind, nonce] = a as [Address, ExecCall[], number, bigint];
      return {
        fn: functionName,
        digest: hashTypedData({
          domain: d,
          types: {
            VaultQueue: [
              { name: "account", type: "address" },
              { name: "nonce", type: "uint256" },
              { name: "callsHash", type: "bytes32" },
              { name: "kind", type: "uint8" },
            ],
          },
          primaryType: "VaultQueue",
          message: { account, nonce, callsHash: execCallsHash(calls), kind },
        }),
      };
    }
    case "vaultCancel":
    case "recoveryCancel": {
      const [account, opId, nonce] = a as [Address, Hex, bigint];
      const primaryType = functionName === "vaultCancel" ? "VaultCancel" : "RecoveryCancel";
      return {
        fn: functionName,
        digest: hashTypedData({
          domain: d,
          types: {
            [primaryType]: [
              { name: "account", type: "address" },
              { name: "nonce", type: "uint256" },
              { name: "opId", type: "bytes32" },
            ],
          },
          primaryType,
          message: { account, nonce, opId },
        } as never),
      };
    }
    case "recoveryStartVaultRotation": {
      const [account, newVaultPk, nonce] = a as [Address, Hex, bigint];
      return {
        fn: functionName,
        digest: hashTypedData({
          domain: d,
          types: {
            RecoveryRotate: [
              { name: "account", type: "address" },
              { name: "nonce", type: "uint256" },
              { name: "newVaultPk", type: "bytes32" },
            ],
          },
          primaryType: "RecoveryRotate",
          message: { account, nonce, newVaultPk },
        }),
      };
    }
    case "recoveryCancelVaultRotation": {
      const [account, nonce] = a as [Address, bigint];
      return {
        fn: functionName,
        digest: hashTypedData({
          domain: d,
          types: {
            RecoveryCancelRotation: [
              { name: "account", type: "address" },
              { name: "nonce", type: "uint256" },
            ],
          },
          primaryType: "RecoveryCancelRotation",
          message: { account, nonce },
        }),
      };
    }
    default:
      throw new Error(`not a role call: ${functionName}`);
  }
}

/** Replaces the trailing `pqSig` of an executor call (the unsigned form has `0x`). */
export function withPqSig(calldata: Hex, pqSig: Hex): Hex {
  const { functionName, args } = decodeFunctionData({ abi: roleExecutorAbi, data: calldata });
  const a = [...(args as readonly unknown[])];
  a[a.length - 1] = pqSig;
  return encodeFunctionData({ abi: roleExecutorAbi, functionName, args: a } as never);
}

/** The trailing `pqSig` of an executor call. */
export function pqSigOf(calldata: Hex): Hex {
  const { args } = decodeFunctionData({ abi: roleExecutorAbi, data: calldata });
  const a = args as readonly unknown[];
  return a[a.length - 1] as Hex;
}

/** The plain-language framing (shared with the native account) plus the executor call for this action. */
export interface BuiltAaAction extends Omit<BuiltVaultAction, "data"> {
  /** Unsigned executor calldata (empty `pqSig`). */
  calldata: Hex;
  fn: ExecutorFn;
  /** For queued ops: the calls `executeQueued(account, opId, calls)` must repeat. */
  queued?: { kind: number; calls: Array<{ target: Address; value: string; data: Hex }> };
}

const hookCall = (dep: AaDeployment, functionName: string, args: readonly unknown[]): ExecCall => ({
  target: dep.hook,
  value: 0n,
  data: encodeFunctionData({ abi: policyHookAbi, functionName, args } as never),
});
const execCall = (dep: AaDeployment, functionName: string, args: readonly unknown[]): ExecCall => ({
  target: dep.executor,
  value: 0n,
  data: encodeFunctionData({ abi: roleExecutorAbi, functionName, args } as never),
});
const usd6 = (usd: number) => BigInt(Math.round(usd * 100)) * (USD / 100n);

/** The hook / executor setter calls of a config action (`account` first, as `_checkShape` requires). */
function configCalls(account: Address, dep: AaDeployment, req: VaultActionRequest, cur: CurrentPolicy): ExecCall[] {
  switch (req.type) {
    case "setLimits":
      return [
        hookCall(dep, "setCap", [
          account,
          usd6(req.dailyUsd),
          usd6(req.perPaymentUsd),
          cur.maxFeeWeiPerTx,
          cur.maxPriorityFeePerGas ?? 2_000_000_000n,
        ]),
      ];
    case "setRecipientMode":
      return [hookCall(dep, "setRecipientMode", [account, req.mode === "open" ? 0 : 1])];
    case "setToken":
      return [
        hookCall(dep, "setToken", [
          account,
          req.token,
          req.allowed,
          req.decimals,
          req.allowed ? BigInt(req.usdPerToken) : 0n,
        ]),
      ];
    case "setSession": {
      const allowance = usd6(req.allowanceUsd);
      const removal = allowance === 0n || req.expiry === 0;
      return [
        hookCall(dep, "setSession", [
          account,
          req.target,
          req.selector,
          removal ? 0n : allowance,
          removal ? 0 : req.expiry,
        ]),
      ];
    }
    case "freeze":
      return [hookCall(dep, "freeze", [account, Number(maxUint48)])];
    case "unfreeze":
      return [hookCall(dep, "unfreeze", [account])];
    case "lockdown":
      return [hookCall(dep, "enableBunker", [account])];
    case "setHotKey":
      return [hookCall(dep, "setHotKey", [account, req.hotKey])];
    case "setGuardian":
      return [execCall(dep, "setGuardian", [account, req.guardian, req.enabled])];
    case "setRecoveryKey":
      return [execCall(dep, "setRecoveryKey", [account, req.pk])];
    default:
      throw new Error(`no config calls for ${req.type}`);
  }
}

/**
 * Builds the executor call. `nonce` is the role's next nonce (`getRoles`). Tightening and spends within the Vault's
 * instant allowance run now (`vaultExec`); loosening and large spends wait (`vaultQueue`); cancels by role.
 */
export function buildAaVaultAction(
  account: Address,
  dep: AaDeployment,
  req: VaultActionRequest,
  cur: CurrentPolicy,
  nonce: bigint,
): BuiltAaAction {
  // Titles, timing (tighten / loosen, instant / queued) and intent are the native account's (same policy rules).
  const meta = buildVaultAction(
    account,
    req.type === "setRecoveryKey" ? { type: "setRecoverySigner", signer: account } : req,
    cur,
  );
  const { data: _d, ...rest } = meta;
  void _d;
  const out = (fn: ExecutorFn, args: readonly unknown[], queued?: BuiltAaAction["queued"]): BuiltAaAction => ({
    ...rest,
    fn,
    calldata: encodeFunctionData({ abi: roleExecutorAbi, functionName: fn, args: [...args, "0x"] } as never),
    ...(queued ? { queued } : {}),
  });
  const json = (calls: ExecCall[]) => calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data }));
  if (req.type === "cancel") {
    return out(req.by === "vault" ? "vaultCancel" : "recoveryCancel", [account, req.opId, nonce]);
  }
  if (req.type === "send") {
    const calls: ExecCall[] = req.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }));
    if (meta.timing === "now") return out("vaultExec", [account, calls, BigInt(req.usd6), nonce]);
    return out("vaultQueue", [account, calls, KIND.spend, nonce], { kind: KIND.spend, calls: json(calls) });
  }
  const calls = configCalls(account, dep, req, cur);
  if (meta.timing === "now") return out("vaultExec", [account, calls, 0n, nonce]);
  return out("vaultQueue", [account, calls, KIND.loosen, nonce], { kind: KIND.loosen, calls: json(calls) });
}

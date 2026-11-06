import { SCHEME_ID } from "@queuebit/pq-signer";
import { ROLE, TX_TYPE, encodeSignRequest, type SignRequest } from "@queuebit/ur";
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { ERC20_ABI, POLICY_HOOK_ABI, ROLE_EXECUTOR_ABI, roleCallDigest } from "../../src/core/clearsign.js";
import { aaModules } from "../../src/core/registry.js";
import { ALICE, recovery, vault } from "./requests.js";

/**
 * tx-type 3 requests (compatible accounts: ERC-4337 + ERC-7579 with the QueueBit modules), shaped as the extension's
 * `buildAaVaultAction` + `AaVault.build` make them: key 4 = a `QueueBitRoleExecutor` call with an empty `pqSig`, key 14 =
 * the executor. The extension's own builder is exercised in test/aa-interop.test.ts.
 */

export const AA_CHAIN_ID = 31337n;
const mods = aaModules(AA_CHAIN_ID)!;
export const EXECUTOR: Address = getAddress(mods.executor);
export const HOOK: Address = getAddress(mods.hook);
export const AA_ACCOUNT: Address = "0x7a5b1c1F2C3D4E5F60718293a4b5C6D7E8F90123";
/** devnet/deploy's 18-decimal test USDC on the local 4337 chain. */
export const AA_USDC: Address = "0x1049a551b5766170A89B7FC0546a2cb2dbC04c78";
export const NEW_VAULT_PK: Hex = `0x${"5e".repeat(28)}c0ffee01`;

export interface BuiltAa {
  request: SignRequest;
  cbor: Uint8Array;
  digest: Hex;
}

const hook = (functionName: string, args: readonly unknown[]) => ({
  target: HOOK,
  value: 0n,
  data: encodeFunctionData({ abi: POLICY_HOOK_ABI, functionName, args } as never),
});
const exec = (functionName: string, args: readonly unknown[]): Hex =>
  encodeFunctionData({ abi: ROLE_EXECUTOR_ABI, functionName, args: [...args, "0x"] } as never);

export function wrapAa(
  calldata: Hex,
  opts: {
    role?: "vault" | "recovery";
    intent?: SignRequest["intent"];
    executor?: Address;
    chainId?: bigint;
    requestId?: string;
  } = {},
): BuiltAa {
  const role = opts.role ?? "vault";
  const chainId = opts.chainId ?? AA_CHAIN_ID;
  const executor = opts.executor ?? EXECUTOR;
  const request: SignRequest = {
    requestId: opts.requestId ?? "4b1d2c3e-5f60-4718-8293-a4b5c6d7e8f9",
    chainId,
    txType: TX_TYPE.roleExecutor7579,
    payload: calldata,
    role: role === "vault" ? ROLE.vault : ROLE.recovery,
    schemeId: SCHEME_ID,
    expectedPk: role === "vault" ? vault.pk : recovery.pk,
    verifyingContract: executor.toLowerCase() as Hex,
    origin: "QueueBit extension",
    ...(opts.intent ? { intent: opts.intent } : {}),
  };
  const { functionName, args } = decodeFunctionData({ abi: ROLE_EXECUTOR_ABI, data: calldata });
  const item = ROLE_EXECUTOR_ABI.find((i) => i.type === "function" && i.name === functionName) as unknown as {
    inputs: { name: string }[];
  };
  const named = Object.fromEntries(item.inputs.map((inp, i) => [inp.name, (args as unknown[])[i]]));
  return { request, cbor: encodeSignRequest(request), digest: roleCallDigest(chainId, executor, functionName, named) };
}

/** Tighten the limits now: daily $40, per payment $10 (hook `setCap`, instant in `vaultExec`). */
export function aaTightenLimits(): BuiltAa {
  return wrapAa(
    exec("vaultExec", [
      AA_ACCOUNT,
      [hook("setCap", [AA_ACCOUNT, 40_000_000n, 10_000_000n, 10_000_000_000_000_000n, 1_000_000_000n])],
      0n,
      3n,
    ]),
    { intent: { action: "vaultSetCap", summary: "Lower your limits" } },
  );
}

/** A Vault payment: 250 USDC to Alice, within the instant allowance. */
export function aaSend(to: Address = ALICE): BuiltAa {
  const transfer = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, 250n * 10n ** 18n] });
  return wrapAa(exec("vaultExec", [AA_ACCOUNT, [{ target: AA_USDC, value: 0n, data: transfer }], 250_000_000n, 4n]), {
    intent: { action: "send", recipient: to.toLowerCase() as Hex, amount: 250n * 10n ** 18n, token: AA_USDC },
  });
}

/** "Let your everyday key pay any address" (a loosening: queued). */
export function aaQueueOpenMode(): BuiltAa {
  return wrapAa(exec("vaultQueue", [AA_ACCOUNT, [hook("setRecipientMode", [AA_ACCOUNT, 0])], 1, 5n]), {
    intent: { action: "vaultSetRecipientMode", summary: "Pay anyone" },
  });
}

/** A call through the account to a contract the registry doesn't know. */
export function aaUnknownCall(): BuiltAa {
  return wrapAa(
    exec("vaultExec", [
      AA_ACCOUNT,
      [{ target: "0x00000000000000000000000000000000DeaDBeef", value: 0n, data: "0xdeadbeef01" }],
      0n,
      6n,
    ]),
  );
}

/** A hook setter that names another account (the executor would refuse it; the phone shows it as unknown). */
export function aaForeignSetter(): BuiltAa {
  return wrapAa(
    exec("vaultExec", [
      AA_ACCOUNT,
      [hook("freeze", ["0x1111111111111111111111111111111111111111", 2n ** 48n - 1n])],
      0n,
      7n,
    ]),
  );
}

/** Pause everyday spending until the Vault resumes it (`freeze(account, type(uint48).max)`). */
export function aaFreeze(): BuiltAa {
  return wrapAa(exec("vaultExec", [AA_ACCOUNT, [hook("freeze", [AA_ACCOUNT, 2n ** 48n - 1n])], 0n, 8n]));
}

export const ZERO_PK: Hex = `0x${"00".repeat(32)}`;

/**
 * A queued executor-self setter (`setRecoveryKey`): linking a key, or removing it (`pk == 0`). `executor` names the
 * module the call targets AND key 14; an unknown one must not be read as a setting.
 */
export function aaSetRecoveryKey(pk: Hex, executor: Address = EXECUTOR): BuiltAa {
  const data = encodeFunctionData({ abi: ROLE_EXECUTOR_ABI, functionName: "setRecoveryKey", args: [AA_ACCOUNT, pk] });
  return wrapAa(exec("vaultQueue", [AA_ACCOUNT, [{ target: executor, value: 0n, data }], 1, 9n]), { executor });
}

/** Recovery: replace the Vault with a new key (7 days). */
export function aaRotation(): BuiltAa {
  return wrapAa(exec("recoveryStartVaultRotation", [AA_ACCOUNT, NEW_VAULT_PK, 0n]), { role: "recovery" });
}

/** The unsigned calldata with something in the `pqSig` slot (must be refused). */
export function aaPresigned(): BuiltAa {
  const c = aaTightenLimits();
  const { args } = decodeFunctionData({ abi: ROLE_EXECUTOR_ABI, data: c.request.payload });
  const a = [...(args as unknown[])];
  a[a.length - 1] = "0x01";
  return wrapAa(encodeFunctionData({ abi: ROLE_EXECUTOR_ABI, functionName: "vaultExec", args: a } as never));
}

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { factoryAbi, leanAccountAbi } from "./abi.js";
import { encodeValidatorInit, type KeyInit, type Policy } from "./keys.js";

/** Where the LeanAccount stack lives on a chain (devnet/deploy writes these addresses). */
export interface AccountDeployment {
  chainId: number;
  /** LeanPool's DepsRegistry: aggregators post batch roots into per-account rings here. */
  registry: Address;
  keystore: Address;
  implementation: Address;
  factory: Address;
  /** SpendingLimitHook: daily caps for sessions, key expiry in execution. */
  hook: Address;
  /** GuardianRecovery (an executor module). */
  recovery: Address;
}

export interface CreateOptions {
  /** Any 32 bytes; the address is also bound to the whole initial configuration. */
  salt: Hex;
  policy: Policy;
  keys: KeyInit[];
  /** Install SpendingLimitHook (default true: sessions' daily caps and key expiry need it). */
  hook?: boolean;
  guardians?: Address[];
  guardianThreshold?: number;
  /** Seconds a guardian-approved reset waits before anyone can execute it (default 2 days). */
  recoveryDelay?: number;
}

export interface FactoryInit {
  validator: Address;
  validatorInit: Hex;
  hook: Address;
  hookInit: Hex;
  executors: Address[];
  executorInits: Hex[];
}

/** `LeanAccountFactory.Init` for a configuration. */
export function factoryInit(d: AccountDeployment, o: CreateOptions): FactoryInit {
  const withRecovery = (o.guardians?.length ?? 0) > 0;
  return {
    validator: d.keystore,
    validatorInit: encodeValidatorInit(o.policy, o.keys),
    hook: o.hook === false ? zeroAddress : d.hook,
    hookInit: "0x",
    executors: withRecovery ? [d.recovery] : [],
    executorInits: withRecovery
      ? [
          encodeAbiParameters(
            [{ type: "address[]" }, { type: "uint8" }, { type: "uint32" }],
            [o.guardians!, o.guardianThreshold ?? 1, o.recoveryDelay ?? 2 * 86_400],
          ),
        ]
      : [],
  };
}

const CLONE_PREFIX: Hex = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const CLONE_SUFFIX: Hex = "0x5af43d82803e903d91602b57fd5bf3";

/** The account's address before it exists: CREATE2 of the EIP-1167 clone, salted by keccak256(abi.encode(salt, init)),
 * exactly as `LeanAccountFactory._predict` computes it. */
export function predictAccount(d: AccountDeployment, o: CreateOptions): Address {
  const init = factoryInit(d, o);
  const salt = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        {
          type: "tuple",
          components: [
            { name: "validator", type: "address" },
            { name: "validatorInit", type: "bytes" },
            { name: "hook", type: "address" },
            { name: "hookInit", type: "bytes" },
            { name: "executors", type: "address[]" },
            { name: "executorInits", type: "bytes[]" },
          ],
        },
      ],
      [o.salt, init],
    ),
  );
  return getContractAddress({
    opcode: "CREATE2",
    from: d.factory,
    salt,
    bytecode: concat([CLONE_PREFIX, d.implementation, CLONE_SUFFIX]),
  });
}

/** The call that creates (or, if it exists, just funds) the account: `factory.createAccount{value}(salt, init)`. */
export const createAccountCall = (d: AccountDeployment, o: CreateOptions, value = 0n) => ({
  to: d.factory,
  value,
  data: encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [o.salt, factoryInit(d, o)] }),
});

/** `LeanAccount.initialize` calldata for a configuration: what an upgraded UUPS account or a 7702-delegated EOA runs. */
export function initializeData(d: AccountDeployment, o: CreateOptions): Hex {
  const i = factoryInit(d, o);
  return encodeFunctionData({
    abi: leanAccountAbi,
    functionName: "initialize",
    args: [i.validator, i.validatorInit, i.hook, i.hookInit, i.executors, i.executorInits],
  });
}

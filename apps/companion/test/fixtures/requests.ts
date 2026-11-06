import { getProfile, roleSignerPathATx, roleSignerPathBTx, encodeTx, sigHash, type FrameTx } from "@leaked/frames";
import { SCHEME_ID, keygen, schemes } from "@leaked/pq-signer";
import { ROLE, TX_TYPE, encodeSignRequest, toHex, type SignRequest } from "@leaked/ur";
import { encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { ACCOUNT_ABI, ERC20_ABI, ROLE_SIGNER_ABI } from "../../src/core/clearsign.js";
import { payerKeyFromSeed, seedFromEntropy, wordsToEntropy } from "../../src/core/keys.js";

/**
 * Deterministic requests for unit and e2e tests, built the way the extension builds them: a Path-B (or A) role-signer
 * frame tx from `@leaked/frames` with the PQ placeholder, wrapped in `ur:leaked-sign-request`.
 */

export const VAULT_WORDS =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art".split(
    " ",
  );
export const RECOVERY_WORDS =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title".split(
    " ",
  );
export const PASSPHRASE = "correct horse battery";

export const PROFILE_ID = "ethrex-eip8141-tracer";
export const CHAIN_ID = 1337n;
export const ACCOUNT: Address = "0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c";
export const VAULT_SIGNER: Address = "0x1111111111111111111111111111111111111111";
export const RECOVERY_SIGNER: Address = "0x2222222222222222222222222222222222222222";
export const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const ALICE: Address = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B";
export const MALLORY: Address = "0x9999999999999999999999999999999999999999";

function keys(words: string[], role: "vault" | "recovery") {
  const seed = seedFromEntropy(wordsToEntropy(words));
  const kp = keygen(seed, { role });
  const payer = payerKeyFromSeed(seed, role);
  return { pk: toHex(kp.publicKey), payer: payer.address, secretKey: kp.secretKey, payerKey: payer.privateKey };
}

export const vault = keys(VAULT_WORDS, "vault");
export const recovery = keys(RECOVERY_WORDS, "recovery");

const fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

export interface Built {
  request: SignRequest;
  cbor: Uint8Array;
  tx: FrameTx;
  digest: Hex;
}

function wrap(
  roleData: Hex,
  opts: {
    role?: "vault" | "recovery";
    path?: "A" | "B";
    intent?: SignRequest["intent"];
    policy?: SignRequest["policy"];
    requestId?: string;
    innerTarget?: Address;
    /** Another key type / key (leanSphincs-s): its scheme id, witness length and the pk the request names. */
    key?: { schemeId: Hex; sigLength: number; pk: Hex };
  } = {},
): Built {
  const role = opts.role ?? "vault";
  const path = opts.path ?? (role === "vault" ? "B" : "A");
  const profile = getProfile(PROFILE_ID);
  const signer = role === "vault" ? VAULT_SIGNER : RECOVERY_SIGNER;
  const target = opts.innerTarget ?? ACCOUNT;
  const common = {
    chainId: CHAIN_ID,
    nonceSeq: 7n,
    fees,
    roleSigner: signer,
    sigLength: opts.key?.sigLength ?? 3688,
    verifyGas: 400_000n,
  };
  const tx =
    path === "B"
      ? roleSignerPathBTx(profile, {
          ...common,
          payerKey: role === "vault" ? vault.payer : recovery.payer,
          body: {
            data: encodeFunctionData({ abi: ROLE_SIGNER_ABI, functionName: "executePQ", args: [0n, target, roleData] }),
            execution: 300_000n,
          },
        })
      : roleSignerPathATx(profile, {
          ...common,
          body: {
            data: encodeFunctionData({ abi: ROLE_SIGNER_ABI, functionName: "relay", args: [target, roleData] }),
            execution: 300_000n,
          },
        });
  const request: SignRequest = {
    requestId: opts.requestId ?? "6f1c2a4e-8b3d-4c5e-9f00-1a2b3c4d5e6f",
    chainId: CHAIN_ID,
    txType: TX_TYPE.frameTx,
    payload: encodeTx(profile, tx),
    role: role === "vault" ? ROLE.vault : ROLE.recovery,
    schemeId: opts.key?.schemeId ?? SCHEME_ID,
    sigIndex: 0,
    expectedPk: opts.key?.pk ?? (role === "vault" ? vault.pk : recovery.pk),
    origin: "LEAKED extension",
    profileId: PROFILE_ID,
    ...(opts.intent ? { intent: opts.intent } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
  };
  return { request, cbor: encodeSignRequest(request), tx, digest: sigHash(profile, tx) };
}

const call = (target: Address, data: Hex, value = 0n) => ({ target, value, data });
const acct = (functionName: string, args: readonly unknown[]) =>
  encodeFunctionData({ abi: ACCOUNT_ABI, functionName: functionName as never, args: args as never });

export const POLICY: NonNullable<SignRequest["policy"]> = {
  account: ACCOUNT.toLowerCase() as Hex,
  capUsdPerDay: 50_000_000n,
  perTxMaxUsd: 20_000_000n,
  maxFeeWeiPerTx: 2_000_000_000_000_000n,
  maxHotFrames: 4,
  timelockDelay: 172_800n,
  timelockThresholdUsd: 1_000_000_000n,
  tokens: [
    { token: USDC.toLowerCase() as Hex, decimals: 6, usdPerToken: 1_000_000n },
    { token: "0x0000000000000000000000000000000000000000", decimals: 18, usdPerToken: 3_000_000_000n },
  ],
};

/** "Raise daily limit from $50 → $200: takes effect after a 48-hour waiting period" (queued loosening). */
export function limitRaise(opts: { intent?: SignRequest["intent"] } = {}): Built {
  const setCap = acct("vaultSetCap", [200_000_000n, 20_000_000n, 2_000_000_000_000_000n, 4]);
  return wrap(acct("vaultQueue", [[call(ACCOUNT, setCap)], 1]), {
    policy: POLICY,
    intent: opts.intent ?? { action: "vaultSetCap", summary: "Raise daily limit to $200" },
  });
}

/** A Vault withdrawal: "Send 250 USDC to Alice (0xAb58…eC9B)". */
export function usdcWithdrawal(opts: { to?: Address; amount?: bigint; intent?: SignRequest["intent"] } = {}): Built {
  const to = opts.to ?? ALICE;
  const amount = opts.amount ?? 250_000_000n;
  const transfer = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });
  return wrap(acct("vaultExecute", [[call(USDC, transfer)], 250_000_000n]), {
    policy: POLICY,
    intent: opts.intent ?? {
      action: "send",
      recipient: to.toLowerCase() as Hex,
      amount,
      token: USDC.toLowerCase() as Hex,
    },
  });
}

/** The browser claims Alice / 250 USDC, the transaction pays Mallory 2,500 USDC. */
export function lyingWithdrawal(): Built {
  return usdcWithdrawal({
    to: MALLORY,
    amount: 2_500_000_000n,
    intent: {
      action: "send",
      recipient: ALICE.toLowerCase() as Hex,
      amount: 250_000_000n,
      token: USDC.toLowerCase() as Hex,
    },
  });
}

/** An ETH send. */
export function ethSend(): Built {
  return wrap(acct("vaultExecute", [[call(ALICE, "0x", 500_000_000_000_000_000n)], 1_500_000_000n]), {
    policy: POLICY,
  });
}

/** A call to a contract the registry doesn't know. */
export function unknownCall(): Built {
  return wrap(
    acct("vaultExecute", [
      [
        call(
          "0x00000000000000000000000000000000DeaDBeef",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
        ),
      ],
      0n,
    ]),
    {
      policy: POLICY,
    },
  );
}

/** The local devnet's Privacy Pools Entrypoint (the registry's 1337 entry: the extension privacy e2e's deployment). */
export const DEVNET_ENTRYPOINT: Address = "0x03b483F613e62e57fE6b2D007ae1b5b7d2a395A9";

/**
 * The extension's shield step as a Vault approval: `vaultExecute([Entrypoint.deposit(precommitment)] + value)`, with
 * the advisory intent the extension sends for it (`send`, no recipient/amount: a contract call).
 */
export function privacyDeposit(
  opts: { entrypoint?: Address; value?: bigint; precommitment?: bigint; label?: string } = {},
): Built {
  const value = opts.value ?? 50_000_000_000_000_000n;
  const data = encodeFunctionData({
    abi: parseAbi(["function deposit(uint256 _precommitment) payable returns (uint256)"]),
    functionName: "deposit",
    args: [opts.precommitment ?? 0x1234n],
  });
  return wrap(acct("vaultExecute", [[call(opts.entrypoint ?? DEVNET_ENTRYPOINT, data, value)], 150_000_000n]), {
    policy: POLICY,
    intent: { action: "send", summary: opts.label ?? "Deposit 0.05 ETH into your private balance (≈ $150)" },
  });
}

/** Admin: Lockdown. */
export function lockdown(): Built {
  return wrap(acct("vaultEnableBunker", []), { policy: POLICY });
}

/** Recovery: replace the Vault (Path A by default, signed by the Recovery key; Path B adds its fee key). */
export function rotation(path: "A" | "B" = "A"): Built {
  return wrap(acct("recoveryStartVaultRotation", ["0x3333333333333333333333333333333333333333"]), {
    role: "recovery",
    path,
  });
}

/** The Privacy Pools note envelope (tx-type 2), signed by the payer key. */
export function noteKeys(
  entrypoint: Address = "0x34A2068192b1297f2a7f85D7D8CdE66F8F0921cB",
  chainId = 11155111n,
): { request: SignRequest; cbor: Uint8Array } {
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
        { name: "salt", type: "bytes32" },
      ],
      PrivacyPoolNote: [
        { name: "depositIndex", type: "uint64" },
        { name: "secretIndex", type: "uint64" },
      ],
    },
    primaryType: "PrivacyPoolNote",
    domain: {
      name: "PrivacyPools Keychain",
      version: "1",
      chainId: Number(chainId),
      verifyingContract: entrypoint,
      salt: keccak256(stringToHex("privacypools")),
    },
    message: { depositIndex: "3", secretIndex: "0" },
  };
  const request: SignRequest = {
    requestId: "0d5e8a7c-1b2f-4e3d-8a9b-0c1d2e3f4a5b",
    chainId,
    txType: TX_TYPE.typedData,
    payload: stringToHex(JSON.stringify(typed)),
    role: ROLE.vault,
    payer: vault.payer.toLowerCase() as Hex,
  };
  return { request, cbor: encodeSignRequest(request) };
}

/** Admin: block Permit2 for everyday-key signatures (instant: tightening). */
export function blockPermit2(): Built {
  return wrap(acct("vaultSetValueVerifier", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", true]), { policy: POLICY });
}

/** Admin: fee rules, queued (raising the priority fee loosens). */
export function feePolicy(): Built {
  const set = acct("vaultSetFeePolicy", [2_000_000_000n, false, "0x4444444444444444444444444444444444444444"]);
  return wrap(acct("vaultQueue", [[call(ACCOUNT, set)], 1]), { policy: POLICY });
}

/** Admin (audit addition): trust a contract with everyday-key signatures; loosening, so queued. */
export function trustVerifier(): Built {
  const set = acct("vaultSetTrustedVerifier", ["0x5555555555555555555555555555555555555555", true]);
  return wrap(acct("vaultQueue", [[call(ACCOUNT, set)], 1]), { policy: POLICY });
}

/** Recipient mode (`RecipientMode` Open = 0, Strict = 1): Strict is instant, Open is a queued loosening. */
export function recipientMode(mode: "open" | "strict", queued = mode === "open"): Built {
  const set = acct("vaultSetRecipientMode", [mode === "open" ? 0 : 1]);
  return wrap(queued ? acct("vaultQueue", [[call(ACCOUNT, set)], 1]) : set, {
    policy: POLICY,
    intent: { action: "vaultSetRecipientMode", summary: mode === "open" ? "Pay anyone" : "Approved only" },
  });
}

/** leanSphincs-s Vault keys of the fixture words: key #1 ("any") and key #2 ("any-2"). */
export function leanKey(keyNumber = 1) {
  const seed = seedFromEntropy(wordsToEntropy(VAULT_WORDS));
  const kp = schemes.leanSphincsS.keygen(seed, {
    role: "vault",
    chainScope: keyNumber === 1 ? "any" : `any-${keyNumber}`,
  });
  return { pk: toHex(kp.publicKey), secretKey: kp.secretKey };
}

/** A leanSphincs-s Vault request (Path A: its VERIFY fits the stock mempool): pause everyday spending. */
export function leanFreeze(pk: Hex, requestId?: string): Built {
  return wrap(acct("vaultFreeze", []), {
    path: "A",
    policy: POLICY,
    ...(requestId ? { requestId } : {}),
    key: { schemeId: schemes.leanSphincsS.SCHEME_ID, sigLength: schemes.leanSphincsS.SIG_LENGTH, pk },
  });
}

export const LEAN_SCHEME_ID = schemes.leanSphincsS.SCHEME_ID;

/** The typed registrations (`6324659`) reaching the phone inside a Vault batch (the account calling itself). */
export function typedRegistrations(): Built {
  const deadline = 1_893_456_000n;
  return wrap(
    acct("vaultExecute", [
      [
        call(ACCOUNT, acct("registerPermit2", [USDC, 25_000_000n, 1_893_456_000, ALICE, deadline, "0x00000000"])),
        call(ACCOUNT, acct("registerPermit2Transfer", [USDC, 5_000_000n, ALICE, 300n, deadline, "0x00000000"])),
        call(
          ACCOUNT,
          acct("registerTransferAuthorization", [USDC, 1_000_000n, ALICE, 0n, deadline, `0x${"ab".repeat(32)}`, false]),
        ),
      ],
      0n,
    ]),
    { policy: POLICY },
  );
}

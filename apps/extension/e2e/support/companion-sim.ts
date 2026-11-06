import {
  type Abi,
  decodeFunctionData,
  hashTypedData,
  keccak256,
  encodeAbiParameters,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  hexToBytes,
  http,
  parseAbiItem,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RelayClient, fingerprintWords, linkSecretOf, parsePairFragment, requestChannel } from "@queuebit/relay-client";
import { encodeTx, getProfile, roleSignerPathATx, setSignature, sigHash, signTx, txHash } from "@queuebit/frames";
import { SCHEME_ID, keygen, sign } from "@queuebit/pq-signer";
import { createFrameRpc } from "@queuebit/rpc";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aadFor, decryptWithKey, type EncryptedBlob } from "../../src/background/encryption";
import { FrameEngine } from "../../src/background/engine";
import {
  AnimatedUr,
  ROLE,
  TX_TYPE,
  UR_TYPES,
  UrReceiver,
  decodeSignature,
  encodePqKey,
  encodeSignature,
  singlePartUr,
  type DecodedUr,
  type RecoveryChallenge,
  type SignRequest,
} from "@queuebit/ur";
// The real companion: its clear-signing decoder and its signing worker's logic, run in Node.
import { reviewRequestBytes } from "../../../companion/src/core/clearsign";
import { entropyToWords, seedFromEntropy, wordsToEntropy } from "../../../companion/src/core/keys";
import { handle } from "../../../companion/src/worker/handler";
import { pqRoleSignerAbi, roleExecutorAbi, roleSignerFactoryAbi } from "../../src/generated/contracts";

/**
 * A simulated QueueBit Vault phone for the extension e2e (bundled by e2e/build-helpers.ts): the companion's own
 * decoder (`reviewRequestBytes`) and worker (`handle`) answer the extension's codes through the paste fallback, so
 * the interop under test is the real one. Also the devnet-only operator stand-ins the run needs (funding, a test
 * token, staking the Recovery signer: see `stakeRecoverySigner`).
 */

const RPC = "http://localhost:8545";
/** The local 4337 chain (devnet/deploy `bun run up:4337`). */
export const RPC_4337 = "http://localhost:8546";
const FUNDER: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil #7 (extension e2e)
const PASS = "e2e vault passphrase";
const profile = getProfile("ethrex-eip8141-tracer");
const pub = createPublicClient({ transport: http(RPC) });
const node = createFrameRpc(RPC).node;

const parts = (type: (typeof UR_TYPES)[keyof typeof UR_TYPES], cbor: Uint8Array) => {
  const a = new AnimatedUr(type, cbor);
  return a.parts(a.partCount).join("\n");
};

function decode(
  text: string,
  type: (typeof UR_TYPES)[keyof typeof UR_TYPES],
): { cbor: Uint8Array; decoded: DecodedUr } {
  const rx = new UrReceiver([type]);
  for (const line of text.split(/\s+/u)) {
    if (!line) continue;
    const r = rx.receive(line);
    if (r.status === "complete") return { cbor: r.cbor, decoded: r.decoded };
    if (r.status === "error") throw r.error;
  }
  throw new Error("incomplete UR");
}

/** The typed-data signature inside a `ur:queuebit-signature` answer (a note key: what the note secrets derive from). */
export function typedSignatureIn(answerText: string): Hex {
  const sig = decodeSignature(decode(answerText, UR_TYPES.signature).cbor).typedSig;
  if (!sig) throw new Error("the answer carries no typed-data signature");
  return sig;
}

export interface Phone {
  vaultPk: Hex;
  payer: Address;
  recoveryPk: Hex;
  pairingText: string;
  recoveryPayer: Address;
  recoveryKeyText: string;
  /** The phone scans the browser's `ur:queuebit-recovery-challenge` and answers with a v2 test over its request id. */
  recoveryTestText(challengeText: string): Promise<string>;
  /** Decodes the request like the phone, signs it with the Vault (or the Recovery key) and returns the answer as text. */
  approve(
    requestText: string,
    mode?: "vault" | "recovery",
    opts?: {
      /** The user confirms an "Unrecognised call" on the phone (the companion's unknown-action flow). */
      allowUnknown?: boolean;
    },
  ): Promise<{ text: string; headline: string; mismatch: string[]; unknown: boolean; kind: string }>;
  /** Operator bootstrap only (`stakeRecoverySigner`): a raw C13 signature by the Recovery key over `digest`. */
  approveRaw(digest: Hex): Promise<Hex>;
}

export async function newPhone(): Promise<Phone> {
  const vaultEntropy = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEntropy = crypto.getRandomValues(new Uint8Array(32));
  const vaultWords = entropyToWords(vaultEntropy);
  const recoveryWords = entropyToWords(recoveryEntropy);
  const created = await handle(
    {
      op: "create",
      entropy: wordsToEntropy(vaultWords),
      bip39Passphrase: "",
      passphrase: PASS,
      kdf: { N: 2 ** 10, r: 8, p: 1 },
      restored: false,
    },
    () => undefined,
  );
  if (created.op !== "create") throw new Error("create");
  let recoveryPayer: Address | undefined;
  const loadRecovery = async () => {
    const r = await handle(
      { op: "recoveryLoad", entropy: wordsToEntropy(recoveryWords), bip39Passphrase: "" },
      () => undefined,
    );
    if (r.op !== "recoveryLoad") throw new Error("recoveryLoad");
    recoveryPayer = r.payerAddress;
    return r.pk;
  };
  const recoveryPk = await loadRecovery();
  await handle({ op: "recoveryWipe" }, () => undefined);
  const ctx = (mode: "vault" | "recovery") => ({
    mode,
    publicKey: mode === "vault" ? created.vaultPk : recoveryPk,
    schemeId: SCHEME_ID,
    payerAddress: mode === "vault" ? created.payerAddress : recoveryPayer!,
    addressBook: [],
    snapshots: [],
  });
  return {
    vaultPk: created.vaultPk,
    payer: created.payerAddress,
    recoveryPk,
    pairingText: singlePartUr(
      UR_TYPES.pqKey,
      encodePqKey({
        schemeId: SCHEME_ID,
        pk: created.vaultPk,
        role: ROLE.vault,
        payer: created.payerAddress.toLowerCase() as Hex,
      }),
    ),
    recoveryPayer: recoveryPayer!,
    recoveryKeyText: singlePartUr(
      UR_TYPES.pqKey,
      encodePqKey({
        schemeId: SCHEME_ID,
        pk: recoveryPk,
        role: ROLE.recovery,
        payer: recoveryPayer!.toLowerCase() as Hex,
      }),
    ),
    async recoveryTestText(challengeText) {
      const ch = decode(challengeText, UR_TYPES.recoveryChallenge).decoded.value as RecoveryChallenge;
      if (ch.recoveryPk.toLowerCase() !== recoveryPk.toLowerCase()) throw new Error("challenge for another key");
      await loadRecovery();
      // The worker signs over the scanned challenge (companion: `challenge {requestId, recoveryPk, expiresAt}`; the
      // earlier worker took `requestId` alone: both are passed so the stand-in follows the companion in either state).
      const t = await handle(
        {
          op: "recoveryTest",
          challenge: { requestId: ch.requestId, recoveryPk: ch.recoveryPk, expiresAt: Date.now() + 10 * 60_000 },
          requestId: ch.requestId,
        } as never,
        () => undefined,
      );
      await handle({ op: "recoveryWipe" }, () => undefined);
      if (t.op !== "recoveryTest") throw new Error("recoveryTest");
      return parts(UR_TYPES.recoveryTest, t.cbor);
    },
    async approveRaw(digest) {
      const kp = keygen(seedFromEntropy(wordsToEntropy(recoveryWords)), { role: "recovery" });
      try {
        return toHex(sign(kp.secretKey, hexToBytes(digest)));
      } finally {
        kp.secretKey.fill(0);
      }
    },
    async approve(requestText, mode = "vault", opts = {}) {
      const { cbor, decoded } = decode(requestText, UR_TYPES.signRequest);
      const req = decoded.value as SignRequest;
      if (req.txType === TX_TYPE.roleExecutor7579) {
        // tx-type 3 (4337 backend). The companion refuses it today (E-76, BACKLOG); this stand-in does what its
        // reviewer must: recompute the EIP-712 digest from key 4 + key 14 alone, check the expected key, sign it.
        const pk = mode === "vault" ? created.vaultPk : recoveryPk;
        if (req.expectedPk!.toLowerCase() !== pk.toLowerCase()) throw new Error("E-71: request for another key");
        const { headline, digest } = executorRequestDigest(req);
        const seed = seedFromEntropy(wordsToEntropy(mode === "vault" ? vaultWords : recoveryWords));
        const kp = keygen(seed, { role: mode });
        try {
          if (toHex(kp.publicKey).toLowerCase() !== pk.toLowerCase()) throw new Error("key derivation");
          const witness = toHex(sign(kp.secretKey, hexToBytes(digest)));
          return {
            text: parts(
              UR_TYPES.signature,
              encodeSignature({ requestId: req.requestId, schemeId: SCHEME_ID, witness }),
            ),
            headline,
            mismatch: [],
            unknown: false,
            kind: "roleCall",
          };
        } finally {
          kp.secretKey.fill(0);
        }
      }
      const review = reviewRequestBytes(cbor, ctx(mode));
      if (review.unknown && !opts.allowUnknown)
        throw new Error(`the phone does not recognise this request: ${review.headline}`);
      if (mode === "recovery") await loadRecovery();
      const r = await handle(
        {
          op: "sign",
          mode,
          ...(mode === "vault" ? { sealed: created.sealed, vaultPk: created.vaultPk, passphrase: PASS } : {}),
          requestCbor: cbor,
          expectDigest: review.digest,
          allowUnknown: !!opts.allowUnknown && !!review.unknown,
        },
        () => undefined,
      );
      if (r.op !== "sign") throw new Error("sign");
      return {
        text: parts(UR_TYPES.signature, r.signatureCbor),
        headline: review.headline,
        mismatch: review.mismatch,
        unknown: !!review.unknown,
        kind: review.kind,
      };
    },
  };
}

/**
 * The phone's reading of a tx-type 3 request (spec for the companion, BACKLOG "Companion: tx-type 3"): decode the
 * `QueueBitRoleExecutor` call in key 4, refuse a non-empty `pqSig`, and hash it in the executor's EIP-712 domain
 * `{ "QueueBitRoleExecutor", "1", chainId (key 2), verifyingContract (key 14) }`.
 */
export function executorRequestDigest(req: SignRequest): { headline: string; digest: Hex } {
  const { functionName, args } = decodeFunctionData({ abi: roleExecutorAbi, data: req.payload });
  const a = args as readonly unknown[];
  if (a[a.length - 1] !== "0x") throw new Error("E-72: the request already carries a signature");
  const domain = {
    name: "QueueBitRoleExecutor",
    version: "1",
    chainId: Number(req.chainId),
    verifyingContract: req.verifyingContract!,
  } as const;
  const callsHash = (calls: unknown) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
        [
          (calls as Array<{ target: Address; value: bigint; data: Hex }>).map(
            (c) => [c.target, c.value, c.data] as const,
          ),
        ],
      ),
    );
  const f = (n: string, t: string) => ({ name: n, type: t });
  switch (functionName) {
    case "vaultExec":
      return {
        headline: "Vault: run now",
        digest: hashTypedData({
          domain,
          types: {
            VaultExec: [
              f("account", "address"),
              f("nonce", "uint256"),
              f("callsHash", "bytes32"),
              f("usdValue", "uint256"),
            ],
          },
          primaryType: "VaultExec",
          message: {
            account: a[0] as Address,
            nonce: a[3] as bigint,
            callsHash: callsHash(a[1]),
            usdValue: a[2] as bigint,
          },
        }),
      };
    case "vaultQueue":
      return {
        headline: "Vault: schedule",
        digest: hashTypedData({
          domain,
          types: {
            VaultQueue: [f("account", "address"), f("nonce", "uint256"), f("callsHash", "bytes32"), f("kind", "uint8")],
          },
          primaryType: "VaultQueue",
          message: { account: a[0] as Address, nonce: a[3] as bigint, callsHash: callsHash(a[1]), kind: Number(a[2]) },
        }),
      };
    case "vaultCancel":
    case "recoveryCancel": {
      const primaryType = functionName === "vaultCancel" ? "VaultCancel" : "RecoveryCancel";
      return {
        headline: `${primaryType}`,
        digest: hashTypedData({
          domain,
          types: { [primaryType]: [f("account", "address"), f("nonce", "uint256"), f("opId", "bytes32")] },
          primaryType,
          message: { account: a[0] as Address, nonce: a[2] as bigint, opId: a[1] as Hex },
        } as never),
      };
    }
    default:
      throw new Error(`E-76: ${functionName} is not handled by this stand-in`);
  }
}

// ---- devnet operator stand-ins ------------------------------------------------------------------------------------

const funder = createWalletClient({ transport: http(RPC), account: privateKeyToAccount(FUNDER) });
const funder4337 = createWalletClient({ transport: http(RPC_4337), account: privateKeyToAccount(FUNDER) });
const pub4337 = createPublicClient({ transport: http(RPC_4337) });

/** Funds on the local 4337 chain (anvil automines). */
export async function fund4337(to: string, eth: string): Promise<void> {
  const hash = await funder4337.sendTransaction({ to: to as Address, value: parseEther(eth), chain: null });
  await pub4337.waitForTransactionReceipt({ hash });
}

/** `token.permit(owner, spender, value, deadline, signature)` from the funder (a site consuming the pre-approval). */
export async function consumePermit(
  chain: 1337 | 31337,
  token: Address,
  args: { owner: Address; spender: Address; value: bigint; deadline: bigint; signature: Hex },
): Promise<bigint> {
  const abi = [
    {
      type: "function",
      name: "permit",
      stateMutability: "nonpayable",
      inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
      outputs: [],
    },
    {
      type: "function",
      name: "allowance",
      stateMutability: "view",
      inputs: [{ type: "address" }, { type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ] as const;
  const w = chain === 1337 ? funder : funder4337;
  const p = chain === 1337 ? pub : pub4337;
  const hash = await w.writeContract({
    address: token,
    abi,
    functionName: "permit",
    args: [args.owner, args.spender, args.value, args.deadline, args.signature],
    ...(chain === 1337 ? { gas: 400_000n, gasPrice: 2_000_000_000n, type: "legacy" as const } : {}),
    chain: null,
  });
  const r = await p.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error("permit reverted");
  return p.readContract({ address: token, abi, functionName: "allowance", args: [args.owner, args.spender] });
}

export async function fund(to: string, eth: string): Promise<void> {
  const hash = await funder.sendTransaction({
    to: to as Address,
    value: parseEther(eth),
    gas: 250_000n,
    gasPrice: 2_000_000_000n,
    type: "legacy",
    chain: null,
  });
  await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
}

/** Deploys an ERC-2612 test token (PermitToken1271 from contracts/out) and mints to `to`. */
export async function deployPermitToken(art: { abi: unknown[]; bytecode: Hex }, to: Address): Promise<Address> {
  const abi = art.abi as Abi;
  const data = encodeDeployData({ abi, bytecode: art.bytecode, args: ["E2EUSD"] });
  const hash = await funder.sendTransaction({
    data,
    gas: 6_000_000n,
    gasPrice: 2_000_000_000n,
    type: "legacy",
    chain: null,
  });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const token = r.contractAddress!;
  const mint = await funder.sendTransaction({
    to: token,
    data: encodeFunctionData({ abi, functionName: "mint", args: [to, 10n ** 24n] }),
    gas: 200_000n,
    gasPrice: 2_000_000_000n,
    type: "legacy",
    chain: null,
  });
  await pub.waitForTransactionReceipt({ hash: mint, timeout: 180_000 });
  return token;
}

const DERIVED = parseAbiItem(
  "event RoleSignerDerived(uint8 indexed role, address indexed signer, address indexed factory, bytes32 salt, bytes32 pk, address verifier, address payerKey)",
);

/**
 * DEVNET-ONLY BOOTSTRAP (documented in IMPLEMENTATION-NOTES / BACKLOG): a Recovery signer has no classical fee key
 * (the companion pairs none), so it can only send Path A, which for C13 (151,701 VERIFY gas) needs the staked lane;
 * and it can only stake through a transaction it signs itself. There is no way out of that loop on the public lanes
 * today. The e2e plays the operator: anyone deploys the derived clone (from the account's `RoleSignerDerived` log),
 * then a Path A `relay(self, stake(...))` signed with the Recovery key is mined through ethrex's private builder hook
 * (`ethrex_submitPrivilegedFrameTransaction`, local devnet only). After that the extension's own Path A recovery
 * approval goes through the BUDGET-010 sidecar like any staked role signer.
 */
export async function stakeRecoverySigner(
  account: Address,
  recoveryPhone: Pick<Phone, "approveRaw">,
): Promise<Address> {
  const logs = await pub.getLogs({ address: account, event: DERIVED, fromBlock: 0n });
  const rec = logs.find((l) => l.args.role === 2);
  if (!rec) throw new Error("no derived Recovery signer");
  const { signer, factory, salt, pk, verifier, payerKey } = rec.args as {
    signer: Address;
    factory: Address;
    salt: Hex;
    pk: Hex;
    verifier: Address;
    payerKey: Address;
  };
  const code = await pub.getCode({ address: signer });
  if (!code || code === "0x") {
    const hash = await funder.sendTransaction({
      to: factory,
      data: encodeFunctionData({
        abi: roleSignerFactoryAbi,
        functionName: "createRoleSigner",
        args: [salt, 2, account, pk, verifier, payerKey],
      }),
      // The stake (0.012) plus the sidecar's minimum signer balance (0.1 ETH, skandha_config.minSignerBalance).
      value: parseEther("0.2"),
      gas: 1_000_000n,
      gasPrice: 2_000_000_000n,
      type: "legacy",
      chain: null,
    });
    await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  }
  const nonceSeq = await node.getTransactionCount(signer, "pending");
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n;
  const tx = roleSignerPathATx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2n * base + 1_000_000_000n },
    roleSigner: signer,
    sigLength: 3688,
    verifyGas: 300_000n,
    body: {
      data: encodeFunctionData({
        abi: pqRoleSignerAbi,
        functionName: "relay",
        args: [
          signer,
          encodeFunctionData({ abi: pqRoleSignerAbi, functionName: "stake", args: [86_400, parseEther("0.012")] }),
        ],
      }),
      execution: 400_000n,
      state: 300_000n,
    },
  });
  const signed = setSignature(profile, tx, 0, await recoveryPhone.approveRaw(sigHash(profile, tx)));
  const hash = (await node.transport.request("ethrex_submitPrivilegedFrameTransaction", [
    encodeTx(profile, signed),
  ])) as Hex;
  if (hash.toLowerCase() !== txHash(profile, signed).toLowerCase()) throw new Error("hash mismatch");
  for (let i = 0; i < 90; i++) {
    const r = await node.getTransactionReceipt(hash).catch(() => null);
    if (r) {
      if (r.frameReceipts[1]?.status !== "success") throw new Error("stake reverted");
      return signer;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("stake not mined");
}

// ---- follow-ups e2e (Permit2 on the devnet, the everyday key outside the extension) ----

/** Canonical Uniswap Permit2 (MIT) and the deterministic-deployment proxy it was deployed through on mainnet. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CREATE2_PROXY: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const PERMIT2_SALT: Hex = "0x0000000000000000000000000000000000000000d3af2663da51c10215000000";
/** keccak256 of the canonical init code (mainnet creation bytecode, e2e/fixtures/permit2.initcode.hex). */
const PERMIT2_INITCODE_HASH: Hex = "0xe2be1e05eedf35dacd66c65c862f8150ff9ab4b6b24b9bbe62be71b6b16cf0f8";

function extensionDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(d, "wxt.config.ts"))) {
    const up = dirname(d);
    if (up === d) throw new Error("apps/extension not found");
    d = up;
  }
  return d;
}

/**
 * Puts the canonical Permit2 at its canonical address on the devnet (CREATE2 through the deterministic-deployment
 * proxy with the mainnet salt and init code, so the address and bytecode are the real ones), once.
 */
export async function ensurePermit2(): Promise<Address> {
  const code = await pub.getCode({ address: PERMIT2 });
  if (code && code !== "0x") return PERMIT2;
  const init = readFileSync(join(extensionDir(), "e2e", "fixtures", "permit2.initcode.hex"), "utf8").trim() as Hex;
  if (keccak256(init) !== PERMIT2_INITCODE_HASH) throw new Error("permit2.initcode.hex is not the canonical init code");
  const data = `${PERMIT2_SALT}${init.slice(2)}` as Hex;
  // ~15M gas on this devnet: code deposit is charged as state gas here.
  const est = await pub.estimateGas({ account: funder.account, to: CREATE2_PROXY, data });
  const hash = await funder.sendTransaction({
    to: CREATE2_PROXY,
    data,
    gas: (est * 6n) / 5n,
    gasPrice: 2_000_000_000n,
    type: "legacy",
    chain: null,
  });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const after = await pub.getCode({ address: PERMIT2 });
  if (r.status !== "success" || !after || after === "0x") throw new Error("Permit2 deployment failed");
  return PERMIT2;
}

const PERMIT2_ABI = [
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      {
        name: "permitSingle",
        type: "tuple",
        components: [
          {
            name: "details",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
    outputs: [{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }],
  },
] as const;

/** A site consuming a Permit2 PermitSingle pre-approval: `Permit2.permit(owner, permitSingle, signature)`. */
export async function consumePermit2(args: {
  owner: Address;
  token: Address;
  amount: bigint;
  expiration: number;
  nonce: number;
  spender: Address;
  sigDeadline: bigint;
  signature: Hex;
}): Promise<{ amount: bigint; expiration: number }> {
  const hash = await funder.writeContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "permit",
    args: [
      args.owner,
      {
        details: { token: args.token, amount: args.amount, expiration: args.expiration, nonce: args.nonce },
        spender: args.spender,
        sigDeadline: args.sigDeadline,
      },
      args.signature,
    ],
    gas: 500_000n,
    gasPrice: 2_000_000_000n,
    type: "legacy",
    chain: null,
  });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error("Permit2.permit reverted");
  const [amount, expiration] = await pub.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: [args.owner, args.token, args.spender],
  });
  return { amount, expiration };
}

/** `account.isValidSignature(hash, sig)` as `caller` sees it (eth_call from that address). */
export async function isValidSignatureFrom(account: Address, caller: Address, hash: Hex, sig: Hex): Promise<Hex> {
  return pub.readContract({
    account: caller,
    address: account,
    abi: [
      {
        type: "function",
        name: "isValidSignature",
        stateMutability: "view",
        inputs: [{ type: "bytes32" }, { type: "bytes" }],
        outputs: [{ type: "bytes4" }],
      },
    ],
    functionName: "isValidSignature",
    args: [hash, sig],
  }) as Promise<Hex>;
}

/** The EIP-712 digest of typed data (what Permit2 hands the account's ERC-1271). */
export const typedDigestOf = (td: Parameters<typeof hashTypedData>[0]): Hex => hashTypedData(td);

/**
 * The extension's everyday key at `index` and its fee-tank key, recovered OUTSIDE the extension from a copy of its
 * storage (the keyring blob and the unlocked session's key): what a thief with this browser's data would hold.
 */
export async function stolenHotKeys(
  record: { blob: EncryptedBlob; accounts: { everyday: string } },
  dekHex: string,
  index: number,
): Promise<{ everyday: Hex; feeTank: Hex }> {
  const plain = await decryptWithKey(
    hexToBytes(`0x${dekHex.replace(/^0x/u, "")}`),
    record.blob,
    aadFor(record.accounts.everyday),
  );
  const { mnemonic } = JSON.parse(new TextDecoder().decode(plain)) as { mnemonic: string };
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const k = (p: string) => toHex(root.derive(p).privateKey!);
  return { everyday: k(`m/44'/60'/0'/0/${index}`), feeTank: k(`m/44'/60'/1'/0/0`) };
}

/**
 * An everyday payment built and signed exactly like the extension's (FrameEngine), with the given keys, then
 * simulated by the node: `admitted` false means the account's VERIFY frame refused the key.
 */
export async function simulateHotPayment(o: {
  account: Address;
  keys: { everyday: Hex; feeTank: Hex };
  to: Address;
  valueWei: bigint;
  declaredUsd: bigint;
}): Promise<{ admitted: boolean; reason?: string }> {
  const engine = new FrameEngine(
    {
      getTransactionCount: (a, tag) => node.getTransactionCount(a, tag),
      baseFee: async () => (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n,
      simulate: (raw) => node.simulateFrameTransaction(raw),
      sendRawTransaction: (raw) => node.sendRawTransaction(raw),
      getTransactionReceipt: (h) => node.getTransactionReceipt(h),
    },
    async (profile, tx) => signTx(profile, await signTx(profile, tx, o.keys.everyday, 0), o.keys.feeTank, 1),
  );
  const p = await engine.prepare({
    chainId: 1337,
    profileId: "ethrex-eip8141-tracer",
    account: o.account,
    hotKey: privateKeyToAccount(o.keys.everyday).address,
    tank: privateKeyToAccount(o.keys.feeTank).address,
    calls: [{ target: o.to, value: o.valueWei, data: "0x" }],
    declaredUsd: o.declaredUsd,
  });
  return { admitted: p.verdict.admitted, ...(p.verdict.reason ? { reason: p.verdict.reason } : {}) };
}

// ---- Onboarding v2: the phone over the relay (packages/relay-client, as the companion uses it) ----

/**
 * The phone's camera opened the browser's pairing link: send the pairing code over the relay, as the companion's
 * "Link to browser" does. Returns the 4 words the phone shows and the link secret it keeps for approvals.
 */
export async function phoneLinkOverRelay(
  phone: Phone,
  link: string,
  relayUrl: string,
): Promise<{ words: string[]; linkSecret: string }> {
  const channel = parsePairFragment(link);
  if (!channel) throw new Error(`not a pairing link: ${link}`);
  await new RelayClient(relayUrl).send(channel, { t: "pair", ur: phone.pairingText });
  return { words: fingerprintWords(phone.vaultPk, phone.payer), linkSecret: linkSecretOf(channel) };
}

/** After `phone.approve(...)`: send the signature over the relay, as the companion's Signed screen does. */
export async function phoneSendOverRelay(answerText: string, linkSecret: string, relayUrl: string): Promise<void> {
  const { cbor } = decode(answerText, UR_TYPES.signature);
  const { requestId } = decodeSignature(cbor);
  await new RelayClient(relayUrl).send(requestChannel(linkSecret, requestId), { t: "sig", cbor: toHex(cbor) });
}

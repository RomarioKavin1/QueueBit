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
import { encodeTx, getProfile, roleSignerPathATx, setSignature, sigHash, txHash } from "@leaked/frames";
import { SCHEME_ID, keygen, sign } from "@leaked/pq-signer";
import { createFrameRpc } from "@leaked/rpc";
import {
  AnimatedUr,
  ROLE,
  TX_TYPE,
  UR_TYPES,
  UrReceiver,
  encodePqKey,
  encodeSignature,
  singlePartUr,
  type DecodedUr,
  type RecoveryChallenge,
  type SignRequest,
} from "@leaked/ur";
// The real companion: its clear-signing decoder and its signing worker's logic, run in Node.
import { reviewRequestBytes } from "../../../companion/src/core/clearsign";
import { entropyToWords, seedFromEntropy, wordsToEntropy } from "../../../companion/src/core/keys";
import { handle } from "../../../companion/src/worker/handler";
import { pqRoleSignerAbi, roleExecutorAbi, roleSignerFactoryAbi } from "../../src/generated/contracts";

/**
 * A simulated LEAKED Vault phone for the extension e2e (bundled by e2e/build-helpers.ts): the companion's own
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

export interface Phone {
  vaultPk: Hex;
  payer: Address;
  recoveryPk: Hex;
  pairingText: string;
  recoveryPayer: Address;
  recoveryKeyText: string;
  /** The phone scans the browser's `ur:leaked-recovery-challenge` and answers with a v2 test over its request id. */
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
 * `LeakedRoleExecutor` call in key 4, refuse a non-empty `pqSig`, and hash it in the executor's EIP-712 domain
 * `{ "LeakedRoleExecutor", "1", chainId (key 2), verifyingContract (key 14) }`.
 */
export function executorRequestDigest(req: SignRequest): { headline: string; digest: Hex } {
  const { functionName, args } = decodeFunctionData({ abi: roleExecutorAbi, data: req.payload });
  const a = args as readonly unknown[];
  if (a[a.length - 1] !== "0x") throw new Error("E-72: the request already carries a signature");
  const domain = {
    name: "LeakedRoleExecutor",
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

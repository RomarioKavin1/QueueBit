import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  hexToString,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { UR_TYPES, UrReceiver, encodeSignature, type SignRequest } from "@queuebit/ur";
import {
  ENTRYPOINT_ABI,
  POOL_ABI,
  buildNoteEnvelope,
  commitmentOf,
  deriveNoteSecrets,
  labelOf,
  newTree,
  rootOf,
  type EnvelopeSigner,
  type HostProvider,
  type NoteEnvelope,
  type NoteSignRequest,
  type RawLog,
} from "../src/index.js";

export const POOL: Address = "0x1111111111111111111111111111111111111111";
export const ENTRYPOINT: Address = "0x2222222222222222222222222222222222222222";
export const CHAIN = 1337n;
export const SCOPE = 4242n;
/** A public test key (anvil #9): the "vault payer key" in unit tests. */
export const PAYER_KEY: Hex = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

/** An RFC 6979 software signer: what the vault device does with its payer key. */
export const softwareSigner = (key: Hex = PAYER_KEY): EnvelopeSigner & { calls: number } => {
  const acct = privateKeyToAccount(key);
  const s = {
    calls: 0,
    async signEnvelope(env: NoteEnvelope) {
      s.calls++;
      return acct.signTypedData(env);
    },
  };
  return s;
};

const dataOf = (types: { type: string }[], values: unknown[]) => encodeAbiParameters(types, values);

/** A simulated Privacy Pools v1 pool: emits the same events, in the same order, as `PrivacyPool` + `State`. */
export class SimPool {
  leaves: bigint[] = [];
  logs: RawLog[] = [];
  nonce = 0n;
  block = 100n;
  private logIndex = 0;

  private emit(name: "Deposited" | "Withdrawn" | "Ragequit" | "LeafInserted", args: Record<string, unknown>) {
    const ev = POOL_ABI.find((x) => x.type === "event" && x.name === name)!;
    if (ev.type !== "event") throw new Error();
    const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as never) as Hex[];
    const nonIndexed = ev.inputs.filter((i) => !("indexed" in i && i.indexed));
    this.logs.push({
      address: POOL,
      topics,
      data: dataOf(
        nonIndexed,
        nonIndexed.map((i) => args[i.name!]),
      ),
      blockNumber: this.block,
      logIndex: this.logIndex++,
    });
  }

  private insert(leaf: bigint) {
    this.leaves.push(leaf);
    this.emit("LeafInserted", { _index: BigInt(this.leaves.length), _leaf: leaf, _root: rootOf(this.leaves) });
  }

  nextBlock(n = 1n) {
    this.block += n;
    this.logIndex = 0;
  }

  deposit(value: bigint, precommitment: bigint, depositor: Address = "0x3333333333333333333333333333333333333333") {
    const label = labelOf(SCOPE, ++this.nonce);
    const commitment = commitmentOf(value, label, precommitment);
    this.insert(commitment);
    this.emit("Deposited", {
      _depositor: depositor,
      _commitment: commitment,
      _label: label,
      _value: value,
      _precommitmentHash: precommitment,
    });
    this.nextBlock();
    return { label, commitment };
  }

  withdraw(value: bigint, spentNullifier: bigint, newCommitment: bigint, processooor: Address = ENTRYPOINT) {
    this.insert(newCommitment);
    this.emit("Withdrawn", {
      _processooor: processooor,
      _value: value,
      _spentNullifier: spentNullifier,
      _newCommitment: newCommitment,
    });
    this.nextBlock();
  }

  get root() {
    return rootOf(this.leaves);
  }
}

/**
 * A HostProvider over a SimPool: `getLogs` serves `logs()` (which a test may tamper with) while `call` answers
 * from the pool's true state (what a verified read would return).
 */
export function fakeProvider(
  pool: SimPool,
  o: {
    logs?: () => RawLog[];
    aspRoot?: () => bigint;
    maxRange?: bigint;
    head?: bigint;
    onGetLogs?: (from: bigint, to: bigint) => void;
  } = {},
): HostProvider & { getLogsCalls: number } {
  const p = {
    getLogsCalls: 0,
    readsVerified: true,
    getChainId: async () => CHAIN,
    getBlockNumber: async () => o.head ?? pool.block - 1n,
    async getLogs(f: { fromBlock: bigint; toBlock: bigint }) {
      p.getLogsCalls++;
      o.onGetLogs?.(f.fromBlock, f.toBlock);
      if (o.maxRange !== undefined && f.toBlock - f.fromBlock + 1n > o.maxRange) throw new Error("range too large");
      return (o.logs?.() ?? pool.logs).filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
    async call(c: { to: Address; data: Hex }) {
      if (c.to === POOL) {
        const d = decodeFunctionData({ abi: POOL_ABI, data: c.data });
        const fn = d.functionName;
        const result =
          fn === "currentRoot"
            ? pool.root
            : fn === "currentTreeSize"
              ? BigInt(pool.leaves.length)
              : fn === "currentRootIndex"
                ? pool.leaves.length % 64
                : fn === "roots"
                  ? (d.args![0] as bigint) === BigInt(pool.leaves.length % 64)
                    ? pool.root
                    : 0n
                  : fn === "SCOPE"
                    ? SCOPE
                    : 0n;
        return encodeFunctionResult({ abi: POOL_ABI, functionName: fn, result } as never);
      }
      const d = decodeFunctionData({ abi: ENTRYPOINT_ABI, data: c.data });
      if (d.functionName === "latestRoot") {
        return encodeFunctionResult({ abi: ENTRYPOINT_ABI, functionName: "latestRoot", result: o.aspRoot?.() ?? 0n });
      }
      throw new Error(`unexpected call ${d.functionName}`);
    },
    getBalance: async () => 0n,
    getCode: async () => "0x" as Hex,
    getStorageAt: async () => "0x" as Hex,
    getTransactionCount: async () => 0,
    estimateGas: async () => 0n,
    getGasPrice: async () => 0n,
    request: async () => null,
  };
  return p;
}

/** Secrets for deposit d / change k from a software signer, for building pool histories in tests. */
export async function secretsFor(signer: EnvelopeSigner, d: number, k: number) {
  return deriveNoteSecrets(
    await signer.signEnvelope(
      buildNoteEnvelope({ chainId: CHAIN, entrypoint: ENTRYPOINT, depositIndex: d, secretIndex: k }),
    ),
  );
}

export { newTree };

/** The vault device: scans the request UR, checks it, signs the typed data with its payer key, answers with a UR. */
export async function vaultDevice(req: NoteSignRequest, key: Hex = PAYER_KEY): Promise<Uint8Array> {
  const rx = new UrReceiver([UR_TYPES.signRequest]);
  let decoded: SignRequest | undefined;
  for (let i = 0; i < 50 && !decoded; i++) {
    const r = rx.receive(req.ur.nextPart());
    if (r.status === "complete") decoded = r.decoded.value as SignRequest;
    if (r.status === "error") throw r.error;
  }
  const typed = JSON.parse(hexToString(decoded!.payload));
  const message = { depositIndex: BigInt(typed.message.depositIndex), secretIndex: BigInt(typed.message.secretIndex) };
  const typedSig = await privateKeyToAccount(key).signTypedData({ ...typed, message });
  return encodeSignature({ requestId: decoded!.requestId, typedSig });
}

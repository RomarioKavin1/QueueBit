// Kohaku (@kohaku-eth/privacy-pools, MIT) wired to a custom chain: our own Privacy Pools v1 deployment on the EIP-8141
// devnet, paid out through a PoolPayer frame transaction instead of Kohaku's ERC-4337 paymaster.
//
// What Kohaku does here: note secrets (SignatureSecretManager: EIP-712 note signatures from a BIP-39 keystore), the
// deposit payload (`prepareShield`), sync (Entrypoint/pool events from `entrypoint.deploymentBlock`, both LeanIMTs, the
// ASP root checked against the on-chain RootUpdated), note selection, the withdrawal witness and the Groth16 proof,
// and the deterministic one-shot sender key (`deriveEphemeralSigner`, recoverable from the mnemonic).
//
// What it cannot do (0.1.0-alpha.38), and how this file bridges it, without patching Kohaku:
// - Its paymaster mode builds an ERC-4337 v0.8 userOp + EIP-7702 authorization for a bundler; EIP-8141 frame
//   transactions are not a target. But the proof it makes in that mode commits to exactly PoolPayer's layout:
//   `withdrawal = { processooor: poolsAccountsMap[pool], data: encodeFeeData({ recipient, feeRecipient:
//   paymasterAddress, fee, refundRecipient }) }`. So the paymaster config points both at PoolPayer, and the bundler
//   URL at an in-process stub (served through the Host's `network.fetch`, never the network) that answers the gas
//   price (Kohaku sizes `fee` from it, bounded by the host RPC's fee history) and refuses estimation (Kohaku then
//   keeps its baseline gas). The userOp Kohaku signs is discarded; the proof and the fee are used.
// - Its default prover downloads the circuit artifacts from GitHub; `proverFactory` here proves with the pinned local
//   artifacts (pp.ts, zkey sha256 checked) through the same snarkjs call and Kohaku's own signal mapper.
// - Its ASP services read 0xbow's API or IPFS; on our own deployment we are the ASP postman, so `aspService` serves
//   the label list we posted (Kohaku re-hashes it and checks it against the RootUpdated root).
import { createRequire } from "node:module";
import { PrivacyPoolsV1Protocol, SignatureSecretManager, E_ADDRESS } from "@kohaku-eth/privacy-pools";
import { MnemonicKeystore, MemoryStorage, type Host } from "@kohaku-eth/plugins";
import { raw } from "@kohaku-eth/provider/raw";
import { WithdrawSignalMapper } from "@fatsolutions/privacy-pools-core-circuits";
import type { Address, Hex } from "viem";
import { ETHREX, CHAIN_ID } from "./lib.ts";
import { rpc } from "@forshtat/hegota-support/rpc";
import { WASM, ZKEY, checkArtifacts, type SolProof } from "./pp.ts";

const require = createRequire(import.meta.url);
// snarkjs is GPL-3.0: used as a tool at test time, never vendored or distributed.
const snarkjs = require("snarkjs");

/** Kohaku's ERC-20 asset id for native ETH (the pool's ASSET). */
export const NATIVE = { __type: "erc20" as const, contract: E_ADDRESS as Address };
/** Never resolved: `network.fetch` answers it in-process. */
export const STUB_BUNDLER = "http://kohaku-frame-stub.invalid/rpc";

export type GasPrice = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

function stubBundler(body: string, price: GasPrice): Response {
  const req = JSON.parse(body);
  const tier = { maxFeePerGas: `0x${price.maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${price.maxPriorityFeePerGas.toString(16)}` };
  const out = req.method === "pimlico_getUserOperationGasPrice"
    ? { jsonrpc: "2.0", id: req.id, result: { slow: tier, standard: tier, fast: tier } }
    : { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `frame-tx stub: no ERC-4337 bundler (${req.method})` } };
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
}

export function kohakuHost(mnemonic: string, price: GasPrice): Host {
  const provider = raw({
    request: ({ method, params }: { method: string; params?: unknown[] }) => rpc(ETHREX, method, params ?? []),
  } as any);
  const network = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === STUB_BUNDLER) return stubBundler(String(init?.body ?? "{}"), price);
      return fetch(input, init);
    },
  };
  return { network, storage: new MemoryStorage(), keystore: new MnemonicKeystore(mnemonic), provider };
}

/** Kohaku's prover interface over the pinned local artifacts. */
export async function kohakuProver() {
  checkArtifacts();
  return {
    circuits: undefined as never,
    prove: async (circuit: string, signals: unknown) => {
      if (circuit !== "withdraw") throw new Error(`local prover: only the withdraw circuit is pinned (${circuit})`);
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(signals, WASM, ZKEY);
      return { proof, publicSignals, mappedSignals: WithdrawSignalMapper(publicSignals) };
    },
  };
}

export type Kohaku = {
  protocol: PrivacyPoolsV1Protocol;
  host: Host;
  /** The labels the ASP service serves (set by the postman before Kohaku syncs). */
  aspLabels: bigint[];
};

export function kohaku(args: { mnemonic: string; entrypoint: Address; deploymentBlock: bigint; pool: Address; payer: Address; price: GasPrice }): Kohaku {
  const host = kohakuHost(args.mnemonic, args.price);
  const k: Kohaku = { host, aspLabels: [], protocol: undefined as never };
  k.protocol = new PrivacyPoolsV1Protocol(host, {
    entrypoint: { address: BigInt(args.entrypoint), deploymentBlock: args.deploymentBlock },
    proverFactory: kohakuProver as any,
    aspServiceFactory: () => ({ getAspTree: async () => [k.aspLabels] }),
    paymasterConfig: {
      [Number(CHAIN_ID)]: {
        bundlerUrl: STUB_BUNDLER,
        // Only sent to the stub (estimation, which it refuses): there is no ERC-4337 EntryPoint in this flow.
        entryPointAddress: "0x0000000000000000000000000000000000000000",
        paymasterAddress: args.payer,
        poolsAccountsMap: { [args.pool.toLowerCase()]: args.payer },
      },
    },
  });
  return k;
}

/** The deterministic sender Kohaku's paymaster mode derives for (deposit, withdraw) indices: a fresh EOA per
 *  withdrawal, recoverable from the mnemonic. */
export async function ephemeralSenderKey(k: Kohaku, entrypoint: Address, depositIndex: number, withdrawIndex: number): Promise<Hex> {
  const sm = SignatureSecretManager({ host: k.host, accountIndex: 0 });
  return sm.deriveEphemeralSigner({ chainId: CHAIN_ID, entrypointAddress: BigInt(entrypoint), depositIndex, withdrawIndex });
}

/** snarkjs proof -> the Solidity struct (EIP-197 G2 order, as snarkjs' exportSolidityCallData). */
export function toSolProof(p: { proof: any; publicSignals: (string | bigint)[] }): SolProof {
  const b = (x: string | bigint) => BigInt(x);
  return {
    pA: [b(p.proof.pi_a[0]), b(p.proof.pi_a[1])],
    pB: [[b(p.proof.pi_b[0][1]), b(p.proof.pi_b[0][0])], [b(p.proof.pi_b[1][1]), b(p.proof.pi_b[1][0])]],
    pC: [b(p.proof.pi_c[0]), b(p.proof.pi_c[1])],
    pubSignals: p.publicSignals.map(b) as SolProof["pubSignals"],
  };
}

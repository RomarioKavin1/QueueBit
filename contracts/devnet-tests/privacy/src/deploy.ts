// Deploys the real Privacy Pools v1 contracts (vendored 0xbow sources, built by forge into contracts/out) on the
// local devnet, registers the native-ETH pool, makes `notes` deposits and posts an ASP root containing their labels.
// Everything is funded and sent by anvil #5 (owner, ASP postman, depositor are that one key).
import { encodeFunctionData, type Address, type Hex } from "viem";
import { FUNDER, addr, deploy, send, artifact, log, CHAIN_ID } from "./lib.ts";
import { NATIVE_ASSET, commitmentOf, labelOf, precommitmentOf, scopeOf, secretFrom, tree, type Note } from "./pp.ts";

export type PoolDeployment = {
  verifier: Address; entrypoint: Address; pool: Address; scope: bigint;
  notes: Note[]; stateLeaves: bigint[]; aspLabels: bigint[]; aspRoot: bigint; txs: Record<string, Hex>;
};

export const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
export const NOTE_VALUE = 100_000_000_000_000_000n; // 0.1 ETH per deposit
const ep = artifact("Entrypoint.sol");
const poolArt = artifact("PrivacyPoolSimple.sol");

export async function deployPool(notesCount: number, tag: string): Promise<PoolDeployment> {
  const me = addr(FUNDER);
  const txs: Record<string, Hex> = {};
  const verifier = await deploy(FUNDER, "WithdrawalGroth16Verifier.sol");
  const t3 = await deploy(FUNDER, "PoseidonT3.sol");
  const t4 = await deploy(FUNDER, "PoseidonT4.sol");
  const impl = await deploy(FUNDER, "Entrypoint.sol");
  const init = encodeFunctionData({ abi: ep.abi, functionName: "initialize", args: [me, me] });
  const proxy = await deploy(FUNDER, "ERC1967Proxy.sol", [impl.address, init]);
  const pool = await deploy(FUNDER, "PrivacyPoolSimple.sol", [proxy.address, verifier.address, verifier.address], {
    PoseidonT3: t3.address, PoseidonT4: t4.address,
  });
  Object.assign(txs, { verifier: verifier.hash, entrypoint: proxy.hash, pool: pool.hash });
  const reg = await send(FUNDER, proxy.address, encodeFunctionData({
    abi: ep.abi, functionName: "registerPool", args: [NATIVE_ASSET, pool.address, 0n, 0n, 0n],
  }));
  txs.registerPool = reg.transactionHash;

  const scope = scopeOf(pool.address, CHAIN_ID);
  const notes: Note[] = [];
  for (let k = 1; k <= notesCount; k++) {
    const n: Note = {
      value: NOTE_VALUE, label: labelOf(scope, BigInt(k)),
      nullifier: secretFrom(`${tag}/nullifier/${k}`), secret: secretFrom(`${tag}/secret/${k}`),
    };
    const r = await send(FUNDER, proxy.address, encodeFunctionData({
      abi: ep.abi, functionName: "deposit", args: [precommitmentOf(n.nullifier, n.secret)],
    }) as Hex, NOTE_VALUE, 3_000_000n);
    if (k === 1) txs.deposit1 = r.transactionHash;
    notes.push(n);
  }
  const stateLeaves = notes.map(commitmentOf);
  const aspLabels = notes.map((n) => n.label);
  const aspRoot = tree(aspLabels).root;
  const ur = await send(FUNDER, proxy.address, encodeFunctionData({ abi: ep.abi, functionName: "updateRoot", args: [aspRoot, CID] }));
  txs.updateRoot = ur.transactionHash;
  const d = { verifier: verifier.address, entrypoint: proxy.address, pool: pool.address, scope, notes, stateLeaves, aspLabels, aspRoot, txs };
  log("Privacy Pools v1 deployed (local devnet)", { verifier: d.verifier, entrypoint: d.entrypoint, pool: d.pool, deposits: notesCount, txs, poolDeployGas: pool.gasUsed });
  return d;
}

export { poolArt, ep };

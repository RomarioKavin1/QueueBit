// Experiment (review): does a Path A tx mine via ethrex_submitPrivilegedFrameTransaction when it is NOT first
// offered to the stock mempools? Reuses the signer deployed by the last run.ts (same deterministic PQ key).
//   SIGNER=0x... MOCK=0x... bun run probe-patha.ts
import { bytesToHex, encodeFunctionData, hexToBytes, keccak256, parseEther, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeTx, getProfile, roleSignerPathATx, setSignature, sigHash, txHash, type FrameTx } from "@leaked/frames";
import { SIG_LENGTH, keygen, sign } from "@leaked/pq-signer";
import { artifact, ethrexRaw, log, rpc, waitReceipt } from "./lib.js";

const profile = getProfile("ethrex-eip8141-tracer");
const signer = process.env.SIGNER as Address;
const mock = process.env.MOCK as Address;
const mode = process.env.MODE ?? "direct"; // direct | afterEthrexProbe | afterSidecarProbe
const signerArt = artifact("PQRoleSigner.sol", "PQRoleSigner");
const mockArt = artifact("RoleMocks.sol", "MockLeakedAccount");
const seed = hexToBytes(
  `${keccak256(stringToHex("leaked/devnet-tests/pq/seed/0"))}${keccak256(stringToHex("leaked/devnet-tests/pq/seed/1")).slice(2)}` as Hex,
);
const { secretKey } = keygen(seed, { role: "vault" });
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const data = encodeFunctionData({
  abi: signerArt.abi,
  functionName: "relay",
  args: [mock, encodeFunctionData({ abi: mockArt.abi, functionName: "vaultExecute", args: [[{ target: recipient, value: parseEther("0.001"), data: "0x" }], 0n] })],
});
const nonceSeq = await rpc.node.getTransactionCount(signer, "latest");
const pq = (tx: FrameTx) => setSignature(profile, tx, 0, bytesToHex(sign(secretKey, hexToBytes(sigHash(profile, tx)))));
let tx = pq(roleSignerPathATx(profile, {
  chainId: 1337, nonceSeq, fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  roleSigner: signer, sigLength: SIG_LENGTH, verifyGas: 400_000n, body: { data, execution: 600_000n, state: 400_000n },
}));
log("tx", { mode, nonceSeq, sigHash: sigHash(profile, tx), txHash: txHash(profile, tx), block: await rpc.node.blockNumber() });
if (mode === "afterEthrexProbe") log("ethrex probe", await rpc.node.sendRawTransaction(encodeTx(profile, tx)).catch((e: Error) => e.message));
if (mode === "afterSidecarProbe") log("sidecar probe", await rpc.sidecar.sendFrameTransaction(tx).catch((e: Error) => e.message));
if (mode !== "direct") tx = pq(tx); // fresh witness, as run.ts does
const h = await ethrexRaw<Hex>("ethrex_submitPrivilegedFrameTransaction", [encodeTx(profile, tx)]);
log("privileged", { returned: h, expected: txHash(profile, tx), block: await rpc.node.blockNumber() });
const r = await waitReceipt(h, 45_000).then((x) => ({ block: x.blockNumber, frames: x.frameReceipts.map((f) => f.status) })).catch((e: Error) => ({ error: e.message, block: String(rpc.node.blockNumber()) }));
log("receipt", r);

import { readFileSync } from "node:fs";
import {
  decodeAbiParameters,
  decodeFunctionData,
  hashTypedData,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { leanPoolWitness, recoverSecp256k1Signer, setSignature, sigHash } from "@queuebit/frames";
import {
  buildAndSign,
  executeCall,
  LEAN_PROFILE,
  LEANPOOL_DEPS,
  leanAccountAbi,
  MODE_BATCH,
  MODE_SINGLE,
  typedTx,
  verifyCall,
} from "../src/index.js";
import { D, VK } from "./fixture.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000ac";
const fees = { maxFeePerGas: 2_000_000_000n };

describe("calldata", () => {
  it("single and batch executions", () => {
    const one = decodeFunctionData({
      abi: leanAccountAbi,
      data: executeCall([{ to: ACCOUNT, value: 5n, data: "0x1234" }]),
    });
    expect(one.functionName).toBe("execute");
    expect(one.args![0]).toBe(MODE_SINGLE);
    expect((one.args![1] as Hex).toLowerCase()).toBe(`${ACCOUNT}${"0".repeat(63)}5${"1234"}`.toLowerCase());
    const two = decodeFunctionData({
      abi: leanAccountAbi,
      data: executeCall([{ to: ACCOUNT }, { to: ACCOUNT, value: 1n }]),
    });
    expect(two.args![0]).toBe(MODE_BATCH);
  });
  it("the VERIFY envelope carries the triples and the contract-verified entries", () => {
    const v = decodeFunctionData({ abi: leanAccountAbi, data: verifyCall(D.keystore, [VK], [2]) });
    const [validator, inner] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }], v.args![0] as Hex);
    expect(validator.toLowerCase()).toBe(D.keystore);
    const [tag, triples, entries] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256[]" }],
      inner,
    );
    expect(tag).toBe(LEANPOOL_DEPS);
    expect((triples.length - 2) / 2).toBe(96);
    expect(triples.slice(-64)).toBe(VK.slice(2));
    expect(entries).toEqual([2n]);
  });
});

describe("buildAndSign", () => {
  const base = {
    d: D,
    account: ACCOUNT,
    nonceKey: 1n,
    nonceSeq: 0n,
    calls: [[{ to: ACCOUNT, value: parseEther("0.01") }]],
    ...fees,
  };

  it("an ECDSA session key signs a protocol-verified entry over the sig hash", async () => {
    const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
    const who = privateKeyToAccount(key).address;
    const { tx, pqSigs } = await buildAndSign({ ...base, signers: [{ kind: "ECDSA", address: who, privateKey: key }] });
    expect(pqSigs).toEqual([]);
    expect(await recoverSecp256k1Signer(LEAN_PROFILE, tx, 0)).toBe(who);
  });

  it("a PQ owner signs the sig hash; the witness filled in later leaves it unchanged", async () => {
    const seen: Hex[] = [];
    const { tx, pqSigs } = await buildAndSign({
      ...base,
      signers: [{ kind: "PQ", vk: VK, sign: async (m) => (seen.push(m), "0xabcd") }],
    });
    expect(seen).toEqual([sigHash(LEAN_PROFILE, tx)]);
    expect(pqSigs).toEqual(["0xabcd"]);
    expect(tx.signatures[0]!.signature).toBe("0x");
    const filled = setSignature(LEAN_PROFILE, tx, 0, leanPoolWitness(keccak256("0x01"), 3, [keccak256("0x02")]));
    expect(sigHash(LEAN_PROFILE, filled)).toBe(sigHash(LEAN_PROFILE, tx));
  });

  it("an EIP-712 key signs LeanAccountTx(sigHash, calls) and its entry is abi.encode(keyId, signature)", async () => {
    const wallet = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const keyId = keccak256("0xee");
    let typed: ReturnType<typeof typedTx> | undefined;
    const { tx } = await buildAndSign({
      ...base,
      signers: [{ kind: "EIP712", keyId, signTypedData: async (t) => ((typed = t), wallet.signTypedData(t)) }],
    });
    expect(typed!.message.sigHash).toBe(sigHash(LEAN_PROFILE, tx));
    expect(typed!.message.calls).toEqual([{ to: ACCOUNT, value: parseEther("0.01"), data: "0x" }]);
    const [id, sig] = decodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], tx.signatures[0]!.signature);
    expect(id).toBe(keyId);
    expect((sig.length - 2) / 2).toBe(65);
    const v = decodeFunctionData({ abi: leanAccountAbi, data: tx.frames[0]!.data });
    const [, inner] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }], v.args![0] as Hex);
    expect(decodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }, { type: "uint256[]" }], inner)[2]).toEqual([
      0n,
    ]);
  });

  it("matches the EIP-712 vector the keystore's Forge test checks (a viem signature, i.e. MetaMask's encoding)", () => {
    const v = JSON.parse(
      readFileSync(new URL("../../../contracts/test/account/fixtures/eip712-vector.json", import.meta.url), "utf8"),
    );
    const calls = v.calls.map((c: { target: Address; value: string; callData: Hex }) => ({
      to: c.target,
      value: BigInt(c.value),
      data: c.callData,
    }));
    expect(hashTypedData(typedTx(1337, v.account, v.sigHash, calls))).toBe(v.digest);
  });
});

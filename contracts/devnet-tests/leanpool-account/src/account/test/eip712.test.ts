import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, hashTypedData, keccak256, parseEther, recoverTypedDataAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT } from "../../core/config.ts";
import { typedTx } from "../sdk.ts";

// What MetaMask signs (eth_signTypedData_v4) for a LeanAccount tx. viem's signTypedData is the same EIP-712 encoding.
const mm = privateKeyToAccount("0x000000000000000000000000000000000000000000000000000000000000beef");
const account = "0x00000000000000000000000000000000000000a1" as const;
const sigHash = keccak256(toHex("a frame tx SIG_HASH"));
const calls = [
  { to: "0x00000000000000000000000000000000000000b2" as const, value: parseEther("0.01") },
  {
    to: "0x00000000000000000000000000000000000000c3" as const,
    data: encodeFunctionData({ abi: [{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }], functionName: "transfer", args: ["0x00000000000000000000000000000000000000d4", 5n] }),
  },
];

test("a browser wallet's typed signature recovers to its address and writes the vector Forge checks", async () => {
  const typed = typedTx(account, sigHash, calls);
  const sig = await mm.signTypedData(typed);
  expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(mm.address);
  const vector = {
    account, sigHash, signer: mm.address, digest: hashTypedData(typed), signature: sig,
    calls: typed.message.calls.map((c) => ({ target: c.to, value: c.value.toString(), callData: c.data })),
  };
  fs.writeFileSync(path.join(ROOT, "../../test/account/fixtures/eip712-vector.json"), JSON.stringify(vector, null, 2) + "\n");
});

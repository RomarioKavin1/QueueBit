import { describe, expect, it } from "vitest";
import { concat, hashTypedData, size, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeMultiSend, multiSendSafeTx, packSafeSignatures, SAFE_OPERATION, safeTxTypedData } from "../src/index.js";
import { MULTISEND, SAFE } from "./fixture.js";

describe("Safe adapter", () => {
  it("packs MultiSend entries as operation ‖ to ‖ value ‖ length ‖ data", () => {
    const to = "0x00000000000000000000000000000000000000d1" as Address;
    const packed = encodeMultiSend([{ to, value: 7n, data: "0xabcd" }]);
    expect(packed).toBe(concat(["0x00", to, toHex(7n, { size: 32 }), toHex(2n, { size: 32 }), "0xabcd"]));
  });
  it("runs the batch as a DELEGATECALL into MultiSendCallOnly", () => {
    const tx = multiSendSafeTx(MULTISEND, [], 4n);
    expect(tx.operation).toBe(SAFE_OPERATION.DELEGATECALL);
    expect(tx.to).toBe(MULTISEND);
    expect(tx.nonce).toBe(4n);
  });
  it("sorts owners' signatures by address and turns v 0/1 into 27/28", async () => {
    const o1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
    const o2 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
    const typed = safeTxTypedData(1337, SAFE, multiSendSafeTx(MULTISEND, [], 0n));
    const s1 = await o1.signTypedData(typed);
    const s2 = await o2.signTypedData(typed);
    const low = (s: Hex) =>
      concat([s.slice(0, 130) as Hex, toHex(Number(BigInt(`0x${s.slice(130)}`)) - 27, { size: 1 })]);
    const packed = packSafeSignatures([
      { owner: o2.address, signature: s2 },
      { owner: o1.address, signature: low(s1) },
    ]);
    expect(size(packed)).toBe(130);
    const first = o1.address.toLowerCase() < o2.address.toLowerCase() ? s1 : s2;
    expect(packed.slice(0, 132)).toBe(first);
    expect(hashTypedData(typed)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

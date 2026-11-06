import { describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, keccak256, pad, zeroAddress } from "viem";
import {
  addressKeyId,
  addrKey,
  encodeValidatorInit,
  KEY_INIT_TUPLE,
  keyIdOf,
  KIND,
  POLICY_TUPLE,
  ROLE,
} from "../src/index.js";
import { AGG, VK } from "./fixture.js";

describe("keys", () => {
  it("keyIdOf is keccak256(abi.encode(uint8, bytes32, bytes32)), b defaulting to zero", () => {
    const want = keccak256(
      encodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
        [1, VK, pad("0x", { size: 32 })],
      ),
    );
    expect(keyIdOf(KIND.PQ, VK)).toBe(want);
  });
  it("address keys left-pad the address", () => {
    const a = "0x00000000000000000000000000000000000000c0" as const;
    expect(addrKey(a)).toBe(pad(a, { size: 32 }));
    expect(addressKeyId(KIND.EIP712, a)).toBe(keyIdOf(KIND.EIP712, pad(a, { size: 32 })));
  });
  it("encodes the keystore's install data as abi.encode(Policy, KeyInit[])", () => {
    const p = { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: AGG };
    const data = encodeValidatorInit(p, [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: VK }]);
    const [policy, keys] = decodeAbiParameters(
      [POLICY_TUPLE, { type: "tuple[]", components: KEY_INIT_TUPLE.components }],
      data,
    );
    expect({ ...policy, aggregator: policy.aggregator.toLowerCase() }).toEqual(p);
    expect(keys[0]).toMatchObject({ kind: 1, roles: 3, a: VK, validUntil: 0, perTxCap: 0n, sessionTargets: [] });
    expect(keys[0]!.b).toBe(pad(zeroAddress, { size: 32 }));
  });
});

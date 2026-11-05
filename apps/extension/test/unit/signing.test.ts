import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { accountAbi } from "../../src/generated/contracts";
import { PERMIT2, classifyPersonalSign, classifyTypedData, registerPermitCall } from "../../src/background/signing";

const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const SPENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const domain = { name: "USD Coin", version: "2", chainId: 1337, verifyingContract: TOKEN };

const permit = {
  domain,
  primaryType: "Permit",
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  message: { owner: ACCOUNT, spender: SPENDER, value: "1000000", nonce: "0", deadline: "1893456000" },
};

describe("signature classifier (account audit 2026-11-06)", () => {
  it("personal_sign and SIWE are sign-ins by the everyday key", () => {
    expect(classifyPersonalSign("hello")).toEqual({ kind: "sign-in", rule: "SIG-SIGN-IN" });
    const siwe = "app.example wants you to sign in with your Ethereum account:\n0xabc\n\nURI: https://app.example";
    expect(classifyPersonalSign(siwe)).toMatchObject({ kind: "sign-in", domain: "app.example" });
  });

  it("an ERC-2612 permit becomes registerPermit(token, spender, value, deadline)", () => {
    const c = classifyTypedData(permit);
    expect(c).toMatchObject({ kind: "register-permit", token: TOKEN, spender: SPENDER, value: 1_000_000n });
    if (c.kind !== "register-permit") throw new Error();
    const call = registerPermitCall(ACCOUNT, c);
    expect(call.target).toBe(ACCOUNT);
    const d = decodeFunctionData({ abi: accountAbi, data: call.data });
    expect(d.functionName).toBe("registerPermit");
    expect(d.args).toEqual([TOKEN, SPENDER, 1_000_000n, 1_893_456_000n]);
    // JSON string params (what dapps send) classify the same.
    expect(classifyTypedData(JSON.stringify(permit)).kind).toBe("register-permit");
  });

  it("Permit2 (by type or by verifying contract) needs the Vault", () => {
    const p2 = {
      ...permit,
      primaryType: "PermitSingle",
      types: { PermitSingle: [{ name: "spender", type: "address" }] },
    };
    expect(classifyTypedData(p2)).toMatchObject({ kind: "needs-vault", rule: "SIG-PERMIT2" });
    expect(classifyTypedData({ ...permit, domain: { ...domain, verifyingContract: PERMIT2 } })).toMatchObject({
      rule: "SIG-PERMIT2",
    });
  });

  it("orders and unknown value-bearing schemas need the Vault; zero-value schemas are sign-ins", () => {
    const order = {
      domain,
      primaryType: "OrderComponents",
      types: { OrderComponents: [{ name: "offerer", type: "address" }] },
    };
    expect(classifyTypedData(order)).toMatchObject({ kind: "needs-vault", rule: "SIG-VALUE-BEARING" });
    const odd = { domain, primaryType: "Pay", types: { Pay: [{ name: "amount", type: "uint256" }] } };
    expect(classifyTypedData(odd)).toMatchObject({ kind: "needs-vault", rule: "SIG-UNKNOWN-SCHEMA" });
    const vote = {
      domain,
      primaryType: "Vote",
      types: {
        Vote: [
          { name: "proposal", type: "bytes32" },
          { name: "choice", type: "uint8" },
        ],
      },
    };
    expect(classifyTypedData(vote)).toMatchObject({ kind: "sign-in" });
    expect(classifyTypedData("not json")).toMatchObject({ kind: "needs-vault", rule: "SIG-UNKNOWN-SCHEMA" });
    // A permit with garbage fields is not trusted as a permit.
    expect(classifyTypedData({ ...permit, message: { ...permit.message, value: "lots" } }).kind).toBe("needs-vault");
  });
});

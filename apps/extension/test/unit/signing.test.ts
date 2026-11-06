import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { accountAbi } from "../../src/generated/contracts";
import {
  PERMIT2,
  classifyPersonalSign,
  classifyTypedData,
  permit2Problem,
  permitMismatch,
  registerPermit2Call,
  registerPermitCall,
} from "../../src/background/signing";

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

describe("permit pre-check: what registerPermit could never record as asked", () => {
  it("passes a permit for the connected account on the connected chain", () => {
    expect(permitMismatch(permit, ACCOUNT, 1337)).toBeUndefined();
    expect(permitMismatch(JSON.stringify(permit), ACCOUNT.toLowerCase() as Address, 1337)).toBeUndefined();
    // chainId as a string or hex, as dapps send it
    expect(permitMismatch({ ...permit, domain: { ...domain, chainId: "1337" } }, ACCOUNT, 1337)).toBeUndefined();
    expect(permitMismatch({ ...permit, domain: { ...domain, chainId: "0x539" } }, ACCOUNT, 1337)).toBeUndefined();
  });

  it("refuses another owner (the account would register its own permit, not the one the site asked for)", () => {
    const other = { ...permit, message: { ...permit.message, owner: SPENDER } };
    expect(permitMismatch(other, ACCOUNT, 1337)).toMatch(/another account/u);
  });

  it("refuses another chain, and an unreadable chain id", () => {
    expect(permitMismatch({ ...permit, domain: { ...domain, chainId: 1 } }, ACCOUNT, 1337)).toMatch(/another network/u);
    expect(permitMismatch({ ...permit, domain: { ...domain, chainId: "mainnet" } }, ACCOUNT, 1337)).toMatch(
      /another network/u,
    );
  });

  it("ignores typed data it cannot read (the classifier already refused those)", () => {
    expect(permitMismatch("not json", ACCOUNT, 1337)).toBeUndefined();
    expect(permitMismatch({ ...permit, domain: undefined, message: undefined }, ACCOUNT, 1337)).toBeUndefined();
  });
});

const p2domain = { name: "Permit2", chainId: 1337, verifyingContract: PERMIT2 };
const p2Domain = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const permitSingle = {
  domain: p2domain,
  primaryType: "PermitSingle",
  types: {
    EIP712Domain: p2Domain,
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  message: {
    details: { token: TOKEN, amount: "5000000", expiration: "1000", nonce: "2" },
    spender: SPENDER,
    sigDeadline: "900",
  },
};
const permitTransfer = {
  domain: p2domain,
  primaryType: "PermitTransferFrom",
  types: {
    EIP712Domain: p2Domain,
    PermitTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  message: { permitted: { token: TOKEN, amount: "7" }, spender: SPENDER, nonce: "300", deadline: "900" },
};

describe("Permit2 pre-approvals (registerPermit2 / registerPermit2Transfer)", () => {
  it("PermitSingle and PermitTransferFrom with the canonical domain are everyday registrations", () => {
    const c = classifyTypedData(JSON.stringify(permitSingle));
    expect(c).toEqual({
      kind: "register-permit2",
      rule: "SIG-PERMIT2-SINGLE",
      token: TOKEN,
      amount: 5_000_000n,
      expiration: 1000n,
      nonce: 2n,
      spender: SPENDER,
      sigDeadline: 900n,
    });
    if (c.kind !== "register-permit2") throw new Error();
    const call = registerPermit2Call(ACCOUNT as Address, c, "0x12345678");
    const d = decodeFunctionData({ abi: accountAbi, data: call.data });
    expect(d.functionName).toBe("registerPermit2");
    expect(d.args).toEqual([TOKEN, 5_000_000n, 1000, SPENDER, 900n, "0x12345678"]);

    const t = classifyTypedData(permitTransfer);
    expect(t).toMatchObject({ kind: "register-permit2-transfer", amount: 7n, nonce: 300n, deadline: 900n });
    if (t.kind !== "register-permit2-transfer") throw new Error();
    const td = decodeFunctionData({ abi: accountAbi, data: registerPermit2Call(ACCOUNT as Address, t).data });
    expect(td.functionName).toBe("registerPermit2Transfer");
    expect(td.args).toEqual([TOKEN, 7n, SPENDER, 300n, 900n, "0x00000000"]);
  });

  it("batches, witnesses, a foreign Permit2 or altered fields are refused", () => {
    const batch = { ...permitSingle, primaryType: "PermitBatch", types: { PermitBatch: [] } };
    expect(classifyTypedData(batch)).toMatchObject({ kind: "needs-vault", rule: "SIG-PERMIT2" });
    const other = { ...permitSingle, domain: { ...p2domain, verifyingContract: TOKEN } };
    expect(classifyTypedData(other)).toMatchObject({ rule: "SIG-PERMIT2" });
    const versioned = { ...permitSingle, domain: { ...p2domain, version: "1" } };
    expect(classifyTypedData(versioned)).toMatchObject({ rule: "SIG-PERMIT2" });
    const extra = {
      ...permitTransfer,
      types: {
        ...permitTransfer.types,
        PermitTransferFrom: [...permitTransfer.types.PermitTransferFrom, { name: "witness", type: "bytes32" }],
      },
    };
    expect(classifyTypedData(extra)).toMatchObject({ rule: "SIG-PERMIT2" });
  });

  it("pre-checks: chain, expiry bounds, the Permit2 nonce", () => {
    const c = classifyTypedData(permitSingle);
    const t = classifyTypedData(permitTransfer);
    if (c.kind !== "register-permit2" || t.kind !== "register-permit2-transfer") throw new Error();
    const ok = { chainId: 1337, domainChainId: 1337, now: 100, allowanceNonce: 2n };
    expect(permit2Problem(c, ok)).toBeUndefined();
    expect(permit2Problem(c, { ...ok, domainChainId: 1 })).toMatch(/another network/u);
    expect(permit2Problem(c, { ...ok, allowanceNonce: 3n })).toMatch(/old Permit2 nonce/u);
    expect(permit2Problem(c, { ...ok, now: 1000 })).toMatch(/30 days/u);
    expect(permit2Problem({ ...c, expiration: 100n + 31n * 86_400n }, ok)).toMatch(/30 days/u);
    expect(permit2Problem(c, { ...ok, now: 950 })).toMatch(/already expired/u);
    expect(permit2Problem(t, { chainId: 1337, domainChainId: "1337", now: 100, nonceUsed: false })).toBeUndefined();
    expect(permit2Problem(t, { chainId: 1337, domainChainId: 1337, now: 100, nonceUsed: true })).toMatch(
      /already used/u,
    );
  });
});

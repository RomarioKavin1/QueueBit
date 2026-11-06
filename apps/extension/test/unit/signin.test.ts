import { hashTypedData, recoverAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashMessage as hash7739Message, hashTypedData as hash7739Typed } from "viem/experimental/erc7739";
import { describe, expect, it } from "vitest";
import {
  accountDomain,
  messageText,
  parseSiwe,
  registeredMarker,
  signPersonal7739,
  signTyped7739,
  siweDomainMatches,
  typedDigest,
} from "../../src/background/signin";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const HOT = privateKeyToAccount(KEY).address;
const ACCOUNT = "0x553d9cb1aaaaaaaaaaaaaaaaaaaaaaaaaaaa7721" as Address;

const SIWE = [
  "app.example.com wants you to sign in with your Ethereum account:",
  ACCOUNT,
  "",
  "Sign in to Example",
  "",
  "URI: https://app.example.com",
  "Version: 1",
  "Chain ID: 1337",
  "Nonce: abc12345",
  "Issued At: 2026-11-06T10:00:00Z",
].join("\n");

describe("sign-in (ERC-7739, M3)", () => {
  it("personal_sign: the everyday key signs PersonalSign(prefixed) in the account's EIP-712 domain", async () => {
    const sig = await signPersonal7739(KEY, ACCOUNT, 1337, SIWE);
    const hash = hash7739Message({ message: SIWE, verifierDomain: accountDomain(ACCOUNT, 1337) });
    expect(await recoverAddress({ hash, signature: sig })).toBe(HOT);
    // Bound to the account and the chain: the same message for another account is a different digest.
    expect(hash7739Message({ message: SIWE, verifierDomain: accountDomain(HOT, 1337) })).not.toBe(hash);
  });

  it("typed data: the nested TypedDataSign hash is signed and wrapped with the app domain and contents", async () => {
    const typed = {
      domain: {
        name: "Snapshot",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x00000000000000000000000000000000000000aa" as Address,
      },
      types: {
        Vote: [
          { name: "proposal", type: "string" },
          { name: "choice", type: "uint32" },
        ],
      },
      primaryType: "Vote" as const,
      message: { proposal: "p1", choice: 1 },
    };
    const wrapped = await signTyped7739(KEY, ACCOUNT, 1337, typed);
    const inner = wrapped.slice(0, 132) as Hex; // r ‖ s ‖ v
    const hash = hash7739Typed({ ...typed, verifierDomain: accountDomain(ACCOUNT, 1337) } as never);
    expect(await recoverAddress({ hash, signature: inner })).toBe(HOT);
    // ERC-7739 layout: … ‖ APP_DOMAIN_SEPARATOR ‖ contents ‖ contentsDescription ‖ uint16(len)
    expect(wrapped.length).toBeGreaterThan(132 + 64 * 2);
  });

  it("SIWE domain must be the requesting site (E-50)", () => {
    const f = parseSiwe(SIWE)!;
    expect(f).toMatchObject({
      domain: "app.example.com",
      statement: "Sign in to Example",
      chainId: 1337,
      nonce: "abc12345",
    });
    expect(siweDomainMatches(f.domain, "https://app.example.com")).toBe(true);
    expect(siweDomainMatches(f.domain, "https://app.example.com.evil.io")).toBe(false);
    expect(siweDomainMatches("localhost:3000", "http://localhost:3000")).toBe(true);
    expect(parseSiwe("hello")).toBeUndefined();
  });

  it("shows hex that isn't readable text as hex", () => {
    expect(messageText("0x68656c6c6f")).toBe("hello");
    expect(messageText("0x0001")).toBe("0x0001");
  });

  it("the registered-hash marker is REGISTERED_MARKER ‖ EIP-712 digest", () => {
    const permit = {
      domain: {
        name: "T",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x00000000000000000000000000000000000000aa",
      },
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
      primaryType: "Permit",
      message: { owner: ACCOUNT, spender: HOT, value: "5", nonce: "0", deadline: "99" },
    };
    const d = typedDigest(permit);
    const { EIP712Domain: _drop, ...types } = permit.types;
    void _drop;
    expect(d).toBe(hashTypedData({ ...permit, types } as never));
    expect(registeredMarker(d)).toBe(`0xdc6b87c9${d.slice(2)}`);
  });
});

import { decodeFunctionData, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { sigHash } from "@queuebit/frames";
import {
  addrKey,
  buildDelegatePayment,
  checkGrantPayment,
  decodeExecute,
  delegateNonceKey,
  executeCall,
  findGrants,
  grantCalls,
  grantKeyId,
  grantPaymentCall,
  keyIdOf,
  keystoreAbi,
  KIND,
  LEAN_PROFILE,
  readGrant,
  revokeGrantCalls,
  ROLE,
  spendingLimitHookAbi,
  targetsFromTx,
  validateGrant,
  type Call,
  type Grant,
  type GrantClient,
  type GrantSpec,
} from "../src/index.js";
import { D, TOKEN } from "./fixture.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000acc01";
const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const DELEGATE = wallet.address;
const SHOP: Address = "0x0000000000000000000000000000000000005409";
const OTHER: Address = "0x00000000000000000000000000000000000000e7";
const TOKEN2: Address = "0x00000000000000000000000000000000000070c2";
const NOW = 1_800_000_000;
const DAY = BigInt(Math.floor(NOW / 86_400));

const spec = (o: Partial<GrantSpec> = {}): GrantSpec => ({
  delegate: DELEGATE,
  validUntil: NOW + 86_400,
  eth: { perPayment: parseEther("0.01"), perDay: parseEther("0.05"), recipients: [SHOP] },
  tokens: [{ token: TOKEN, perPayment: parseUnits("10", 6), perDay: parseUnits("50", 6) }],
  ...o,
});

const decode = (c: Call) => {
  const abi = c.to === D.hook ? spendingLimitHookAbi : keystoreAbi;
  const x = decodeFunctionData({ abi, data: c.data! });
  return { fn: x.functionName as string, args: x.args as readonly unknown[] };
};

describe("validateGrant", () => {
  const bad = (g: GrantSpec, re: RegExp) => expect(() => validateGrant(D, ACCOUNT, g, NOW)).toThrow(re);
  it("accepts a grant with ETH and a token", () => validateGrant(D, ACCOUNT, spec(), NOW));
  it("refuses this account as the delegate, a past end, nothing to spend", () => {
    bad(spec({ delegate: ACCOUNT }), /this account/);
    bad(spec({ delegate: "0x1234" as Address }), /wallet address/);
    bad(spec({ validUntil: NOW }), /future/);
    bad(spec({ eth: undefined, tokens: [] } as never), /what they may spend/);
  });
  it("refuses zero limits, a per-payment limit over the daily one, ETH with no recipient", () => {
    bad(spec({ eth: { perPayment: 0n, perDay: 1n, recipients: [SHOP] } }), /one payment/);
    bad(spec({ eth: { perPayment: 2n, perDay: 1n, recipients: [SHOP] } }), /can't be more than the daily/);
    bad(spec({ eth: { perPayment: 1n, perDay: 1n, recipients: [] } }), /at least one address/);
    bad(spec({ tokens: [{ token: TOKEN, perPayment: 5n, perDay: 0n }] }), /in a day/);
  });
  it("refuses the account's own contracts as a recipient (admin targets: a session can never call them)", () => {
    bad(spec({ eth: { perPayment: 1n, perDay: 1n, recipients: [D.keystore] } }), /own contracts/);
    bad(spec({ eth: { perPayment: 1n, perDay: 1n, recipients: [ACCOUNT] } }), /own contracts/);
  });
});

describe("grantCalls: a new grant", () => {
  const calls = grantCalls(D, spec());
  const xs = calls.map(decode);

  it("adds an EIP712 SESSION key for the delegate, expiring, with the ETH per-payment cap and its targets", () => {
    expect(xs[0]!.fn).toBe("addKey");
    const k = xs[0]!.args[0] as {
      kind: number;
      roles: number;
      validUntil: number;
      perTxCap: bigint;
      a: Hex;
      sessionTargets: Address[];
    };
    expect(k.kind).toBe(KIND.EIP712);
    expect(k.roles).toBe(ROLE.SESSION);
    expect(k.validUntil).toBe(NOW + 86_400);
    expect(k.perTxCap).toBe(parseEther("0.01"));
    expect(k.a).toBe(addrKey(DELEGATE).toLowerCase());
    expect(k.sessionTargets).toEqual([SHOP, TOKEN]);
    expect(keyIdOf(KIND.EIP712, k.a)).toBe(grantKeyId(DELEGATE));
  });

  it("sets the daily ETH cap in the hook and the token's per-payment and daily caps", () => {
    const id = grantKeyId(DELEGATE);
    expect(xs.slice(1)).toEqual([
      { fn: "setDailyCap", args: [id, parseEther("0.05")] },
      { fn: "setSessionToken", args: [id, TOKEN, parseUnits("10", 6)] },
      { fn: "setTokenDailyCap", args: [id, TOKEN, parseUnits("50", 6)] },
    ]);
  });

  it("a token-only grant has no ETH: per-payment ETH cap 0, no daily ETH cap set", () => {
    const t = grantCalls(D, spec({ eth: undefined })).map(decode);
    expect((t[0]!.args[0] as { perTxCap: bigint }).perTxCap).toBe(0n);
    expect(t.map((x) => x.fn)).toEqual(["addKey", "setSessionToken", "setTokenDailyCap"]);
  });
});

const grant = (o: Partial<Grant> = {}): Grant => ({
  account: ACCOUNT,
  delegate: DELEGATE,
  keyId: grantKeyId(DELEGATE),
  active: true,
  validUntil: NOW + 3600,
  eth: {
    perPayment: parseEther("0.01"),
    perDay: parseEther("0.05"),
    recipients: [SHOP],
    cap: parseEther("0.05"),
    spentToday: parseEther("0.045"),
    leftToday: parseEther("0.005"),
  },
  tokens: [
    {
      token: TOKEN,
      perPayment: 10_000_000n,
      perDay: 50_000_000n,
      cap: 50_000_000n,
      spentToday: 0n,
      leftToday: 50_000_000n,
    },
  ],
  targets: [SHOP, TOKEN],
  ...o,
});

describe("grantCalls over what the chain holds", () => {
  const id = grantKeyId(DELEGATE);
  it("an active grant is updated in place: new end and ETH cap, new targets added, old ones cleared", () => {
    const next = spec({
      eth: { perPayment: 5n, perDay: 10n, recipients: [OTHER] },
      tokens: [{ token: TOKEN2, perPayment: 1n, perDay: 2n }],
    });
    const xs = grantCalls(D, next, grant()).map(decode);
    expect(xs).toEqual([
      { fn: "updateKey", args: [id, 1, ROLE.SESSION, NOW + 86_400, 5n] },
      { fn: "setSessionTargets", args: [id, [OTHER, TOKEN2], true] },
      { fn: "setDailyCap", args: [id, 10n] },
      { fn: "setSessionToken", args: [id, TOKEN2, 1n] },
      { fn: "setTokenDailyCap", args: [id, TOKEN2, 2n] },
      { fn: "setSessionTargets", args: [id, [SHOP, TOKEN], false] },
      { fn: "setSessionToken", args: [id, TOKEN, 0n] },
    ]);
  });

  it("dropping ETH from an active grant zeroes its caps", () => {
    const xs = grantCalls(D, spec({ eth: undefined }), grant()).map(decode);
    expect(xs[0]).toEqual({ fn: "updateKey", args: [id, 1, ROLE.SESSION, NOW + 86_400, 0n] });
    expect(xs).toContainEqual({ fn: "setDailyCap", args: [id, 0n] });
    expect(xs).toContainEqual({ fn: "setSessionTargets", args: [id, [SHOP], false] });
  });

  it("a revoked (or pruned) key's leftover allowlist and token caps are cleared after the new key is added", () => {
    const stale = grant({
      active: false,
      eth: undefined,
      targets: [OTHER, TOKEN2],
      tokens: [{ ...grant().tokens[0]!, token: TOKEN2 }],
    });
    const xs = grantCalls(D, spec(), stale).map(decode);
    expect(xs[0]!.fn).toBe("addKey");
    expect(xs.slice(-2)).toEqual([
      { fn: "setSessionTargets", args: [id, [OTHER, TOKEN2], false] },
      { fn: "setSessionToken", args: [id, TOKEN2, 0n] },
    ]);
  });
});

describe("revokeGrantCalls", () => {
  it("clears the allowlist and the token caps, then removes the key (they would outlive it otherwise)", () => {
    const id = grantKeyId(DELEGATE);
    expect(revokeGrantCalls(D, grant()).map(decode)).toEqual([
      { fn: "setSessionTargets", args: [id, [SHOP, TOKEN], false] },
      { fn: "setSessionToken", args: [id, TOKEN, 0n] },
      { fn: "removeKey", args: [id] },
    ]);
  });
});

describe("reading a grant from the chain", () => {
  it("decodeExecute reads back single and batch executions", () => {
    const one: Call[] = [{ to: SHOP, value: 7n, data: "0xabcd" }];
    expect(decodeExecute(executeCall(one))).toEqual(one);
    const two: Call[] = [
      { to: SHOP, value: 1n, data: "0x" },
      { to: TOKEN, value: 0n, data: "0x1234" },
    ];
    expect(decodeExecute(executeCall(two))).toEqual(two);
    expect(decodeExecute("0x12345678")).toEqual([]);
  });

  it("targetsFromTx finds the targets the owner's grant tx set, in its SENDER frame", () => {
    const owner = executeCall(grantCalls(D, spec()));
    const tx = { frames: [{ data: "0x8e760afe" as Hex }, { data: owner }] };
    expect(targetsFromTx(tx, D.keystore, grantKeyId(DELEGATE))).toEqual([SHOP, TOKEN]);
    expect(targetsFromTx(tx, D.keystore, grantKeyId(OTHER))).toEqual([]);
    const update = executeCall(
      grantCalls(D, spec({ eth: { perPayment: 1n, perDay: 1n, recipients: [OTHER] } }), grant()),
    );
    expect(targetsFromTx({ frames: [{ data: update }] }, D.keystore, grantKeyId(DELEGATE))).toEqual([OTHER]);
  });

  /** A chain with one account that granted DELEGATE ETH to SHOP and TOKEN; today it spent 0.02 ETH and 5 TOKEN. */
  function fakeChain(o: { removed?: boolean } = {}): GrantClient {
    const id = grantKeyId(DELEGATE);
    const addTx = "0x" + "aa".repeat(32);
    const frames = [{ data: executeCall(grantCalls(D, spec())) }];
    return {
      async readContract({ functionName, args }: { functionName: string; args: unknown[] }) {
        switch (functionName) {
          case "getKey":
            return o.removed
              ? { kind: 0, roles: 0, validUntil: 0, perTxCap: 0n }
              : { kind: KIND.EIP712, roles: ROLE.SESSION, validUntil: NOW + 86_400, perTxCap: parseEther("0.01") };
          case "getKeys":
            return [[id], [{ kind: KIND.EIP712, roles: ROLE.SESSION, a: addrKey(DELEGATE) }]];
          case "isSessionTarget":
            return !o.removed && [SHOP, TOKEN].includes(args[2] as Address);
          case "sessionTokenCap":
            return o.removed ? 0n : parseUnits("10", 6);
          case "limitOf":
            return { dailyCap: parseEther("0.05"), day: DAY, spent: parseEther("0.02") };
          case "tokenLimitOf":
            return { dailyCap: parseUnits("50", 6), day: DAY - 1n, spent: parseUnits("5", 6) };
        }
        throw new Error(functionName);
      },
      async getLogs(q: { args: { account?: Address } }) {
        if (!q.args.account) return [{ args: { account: ACCOUNT } }, { args: { account: ACCOUNT } }];
        return [
          { eventName: "KeyAdded", transactionHash: addTx, args: {} },
          { eventName: "SessionTokenSet", transactionHash: addTx, args: { token: TOKEN } },
        ];
      },
      async request({ params }: { params: [Hex] }) {
        return params[0] === addTx ? { frames } : null;
      },
    } as unknown as GrantClient;
  }

  it("readGrant: limits, today's spend (a past day's spend is not today's), recipients from the grant tx", async () => {
    const g = await readGrant(fakeChain(), D, ACCOUNT, DELEGATE, NOW);
    expect(g.active).toBe(true);
    expect(g.validUntil).toBe(NOW + 86_400);
    expect(g.eth).toEqual({
      perPayment: parseEther("0.01"),
      perDay: parseEther("0.05"),
      recipients: [SHOP],
      cap: parseEther("0.05"),
      spentToday: parseEther("0.02"),
      leftToday: parseEther("0.03"),
    });
    expect(g.tokens).toEqual([
      {
        token: TOKEN,
        perPayment: parseUnits("10", 6),
        perDay: parseUnits("50", 6),
        cap: parseUnits("50", 6),
        spentToday: 0n,
        leftToday: parseUnits("50", 6),
      },
    ]);
    expect(g.targets).toEqual([SHOP, TOKEN]);
  });

  it("findGrants: each granting account once; a removed grant is left out", async () => {
    const found = await findGrants(fakeChain(), D, DELEGATE, NOW);
    expect(found.map((g) => g.account.toLowerCase())).toEqual([ACCOUNT]);
    expect(await findGrants(fakeChain({ removed: true }), D, DELEGATE, NOW)).toEqual([]);
  });
});

describe("the delegate pays", () => {
  const g = grant();
  const ok = (calls: Call[], now = NOW) => checkGrantPayment(D, g, calls, now);

  it("a token to anyone within the caps, ETH to a listed recipient within what is left today", () => {
    expect(ok([grantPaymentCall(TOKEN, OTHER, 10_000_000n)])).toEqual({ ok: true });
    expect(ok([grantPaymentCall("ETH", SHOP, parseEther("0.005"))])).toEqual({ ok: true });
  });

  it("refuses with a reason: unlisted ETH recipient, over one payment, over today's rest, ended, removed", () => {
    expect(ok([grantPaymentCall("ETH", OTHER, 1n)])).toEqual({
      ok: false,
      reason: "You may only send ETH to the addresses the owner listed.",
    });
    expect(ok([grantPaymentCall(TOKEN, OTHER, 10_000_001n)])).toEqual({
      ok: false,
      reason: "That's more than one payment may send.",
    });
    expect(ok([grantPaymentCall("ETH", SHOP, parseEther("0.006"))])).toEqual({
      ok: false,
      reason: "That's more ETH than is left for today.",
    });
    expect(ok([grantPaymentCall(TOKEN, OTHER, 1n)], NOW + 3600)).toEqual({
      ok: false,
      reason: "This permission has ended.",
    });
    expect(checkGrantPayment(D, { ...g, active: false }, [grantPaymentCall(TOKEN, OTHER, 1n)], NOW).ok).toBe(false);
    expect(ok([grantPaymentCall(TOKEN2, OTHER, 1n)]).ok).toBe(false);
  });

  it("buildDelegatePayment: the account sends on the delegate's lane, the wallet signs the calls it executes", async () => {
    let shown: unknown;
    const calls = [grantPaymentCall(TOKEN, OTHER, 5n)];
    const { tx, pqSigs } = await buildDelegatePayment({
      d: D,
      grant: g,
      calls,
      nonceSeq: 3n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      signTypedData: async (t) => ((shown = t), wallet.signTypedData(t)),
    });
    expect(pqSigs).toEqual([]); // no LeanPool: straight to the alt mempool
    expect(tx.sender).toBe(ACCOUNT);
    expect(tx.nonceKeys).toEqual([delegateNonceKey(DELEGATE)]);
    expect(tx.nonceSeq).toBe(3n);
    const t = shown as { domain: { verifyingContract: Address }; message: { sigHash: Hex; calls: unknown[] } };
    expect(t.domain.verifyingContract).toBe(ACCOUNT);
    expect(t.message.sigHash).toBe(sigHash(LEAN_PROFILE, tx));
    expect(t.message.calls).toEqual([{ to: TOKEN, value: 0n, data: calls[0]!.data }]);
  });

  it("the delegate's lane is apart from the owner's (0x1000) and the extension's sessions (1, 2, ...)", () => {
    const k = delegateNonceKey(DELEGATE);
    expect(k >= 1n << 32n && k < 1n << 33n).toBe(true);
  });
});

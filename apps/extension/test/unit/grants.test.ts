import {
  decodeExecute,
  grantKeyId,
  keystoreAbi,
  LEAN_PROFILE,
  spendingLimitHookAbi,
  type Grant,
} from "@queuebit/account";
import { decodeTx } from "@queuebit/frames";
import { decodeFunctionData, parseEther, parseUnits, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  delegateLink,
  grantSentence,
  grantView,
  mergeGrantSpec,
  type GrantRequest,
} from "../../src/background/lean/grants";
import { getNetwork } from "../../src/shared/chains";
import { MNEMONIC, makeWallet } from "./fakes";

const d = getNetwork(1337).deployment!;
const DELEGATE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const SHOP = "0x0000000000000000000000000000000000005409" as Address;
const USDC = { token: "0x00000000000000000000000000000000000070c1" as Address, symbol: "USDC", decimals: 6 };
const DAI = { token: "0x00000000000000000000000000000000000070c2" as Address, symbol: "DAI", decimals: 18 };
const NOW = 1_800_000_000;

const req = (o: Partial<GrantRequest> = {}): GrantRequest => ({
  delegate: DELEGATE,
  asset: "ETH",
  perPayment: "0.01",
  perDay: "0.05",
  validUntil: NOW + 3600,
  recipients: [SHOP],
  ...o,
});

const onChain: Grant = {
  account: "0x00000000000000000000000000000000000acc01",
  delegate: DELEGATE,
  keyId: grantKeyId(DELEGATE),
  active: true,
  validUntil: NOW + 60,
  eth: {
    perPayment: parseEther("0.01"),
    perDay: parseEther("0.05"),
    recipients: [SHOP],
    cap: parseEther("0.05"),
    spentToday: parseEther("0.02"),
    leftToday: parseEther("0.03"),
  },
  tokens: [],
  targets: [SHOP],
};

describe("mergeGrantSpec: one asset at a time, joined to what the person already has", () => {
  it("ETH: amounts in wei, recipients checked and deduplicated", () => {
    const s = mergeGrantSpec(undefined, req({ recipients: [SHOP, SHOP.toLowerCase() as Address] }), [USDC], NOW);
    expect(s.eth).toEqual({ perPayment: parseEther("0.01"), perDay: parseEther("0.05"), recipients: [SHOP] });
    expect(s.tokens).toEqual([]);
    expect(s.validUntil).toBe(NOW + 3600);
    expect(() => mergeGrantSpec(undefined, req({ recipients: ["0x12"] as Address[] }), [], NOW)).toThrow(
      /isn't an address/,
    );
    expect(() => mergeGrantSpec(undefined, req({ perDay: "lots" }), [], NOW)).toThrow(/as a number/);
  });

  it("a token joins an existing ETH grant (which is kept), in the token's decimals; the new end applies to both", () => {
    const s = mergeGrantSpec(
      onChain,
      req({ asset: USDC.token, perPayment: "10", perDay: "50.5", validUntil: NOW + 7200 }),
      [USDC],
      NOW,
    );
    expect(s.eth?.recipients).toEqual([SHOP]);
    expect(s.tokens).toEqual([{ token: USDC.token, perPayment: parseUnits("10", 6), perDay: parseUnits("50.5", 6) }]);
    expect(s.validUntil).toBe(NOW + 7200);
    expect(() => mergeGrantSpec(undefined, req({ asset: USDC.token, perPayment: "0.0000001" }), [USDC], NOW)).toThrow(
      /At most 6 decimals/,
    );
    expect(() => mergeGrantSpec(undefined, req({ asset: DAI.token }), [USDC], NOW)).toThrow(/from the list/);
  });

  it("a revoked grant's leftovers are not carried over", () => {
    const s = mergeGrantSpec(
      { ...onChain, active: false },
      req({ asset: USDC.token, perPayment: "1", perDay: "1" }),
      [USDC],
      NOW,
    );
    expect(s.eth).toBeUndefined();
  });
});

describe("grantView and the sentence the page shows", () => {
  it("ETH (only to listed addresses) and tokens (to anyone), JSON-safe", () => {
    const v = grantView(
      {
        ...onChain,
        tokens: [{ token: USDC.token, perPayment: 10n, perDay: 50n, cap: 50n, spentToday: 5n, leftToday: 45n }],
      },
      [USDC],
    );
    expect(v.assets).toEqual([
      {
        asset: "ETH",
        symbol: "ETH",
        decimals: 18,
        perPayment: parseEther("0.01").toString(),
        perDay: parseEther("0.05").toString(),
        spentToday: parseEther("0.02").toString(),
        leftToday: parseEther("0.03").toString(),
        recipients: [SHOP],
      },
      {
        asset: USDC.token,
        symbol: "USDC",
        decimals: 6,
        perPayment: "10",
        perDay: "50",
        spentToday: "5",
        leftToday: "45",
      },
    ]);
    const fmt = (x: string) => (Number(x) / 1e18).toString();
    expect(grantSentence(v.assets[0]!, fmt, "Fri 5 pm")).toBe(
      "Up to 0.05 ETH a day, 0.01 per payment, only to 1 address, until Fri 5 pm",
    );
    expect(grantSentence(v.assets[1]!, (x) => x, "Fri 5 pm")).toBe(
      "Up to 50 USDC a day, 10 per payment, to anyone, until Fri 5 pm",
    );
    expect(delegateLink("https://q.example/", onChain.account)).toBe(
      `https://q.example/delegate?account=${onChain.account}`,
    );
  });
});

describe("the engine: grants:create / grants:revoke", () => {
  async function ready(confirmEachSignature = false) {
    const m = makeWallet({ confirmEachSignature });
    await m.wallet.keyring.import(MNEMONIC, "password-1");
    await m.wallet.handleUi("setup:update", { completedAt: 1 });
    const st = await m.wallet.handleUi("account:status", { chainId: 1337 });
    m.chain.deploy(st.address!);
    m.chain.fund(st.address!, parseEther("10"));
    return { ...m, account: st.address! };
  }

  it("a grant is one owner admin payment through LeanPool that adds the delegate's EIP712 key", async () => {
    const { wallet, chain } = await ready();
    const entry = await wallet.handleUi("grants:create", {
      ...req(),
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(entry).toMatchObject({ kind: "admin", signer: "owner", via: "leanpool" });
    expect(chain.pooled).toHaveLength(1);
    const tx = decodeTx(LEAN_PROFILE, chain.pooled[0]!.raw);
    const calls = decodeExecute(tx.frames[1]!.data);
    const fns = calls.map(
      (c) => decodeFunctionData({ abi: [...keystoreAbi, ...spendingLimitHookAbi], data: c.data! }).functionName,
    );
    expect(calls[0]!.to.toLowerCase()).toBe(d.keystore.toLowerCase());
    expect(fns).toEqual(["addKey", "setDailyCap"]);
    expect(await wallet.handleUi("grants:list", { chainId: 1337 })).toEqual([]); // the fake chain holds no keys
  });

  it("refuses this account as the delegate, and signs nothing without the passkey or password", async () => {
    const { wallet, chain, account } = await ready(true);
    await expect(
      wallet.handleUi("grants:create", { ...req(), validUntil: Math.floor(Date.now() / 1000) + 3600 }),
    ).rejects.toThrow();
    await expect(
      wallet.handleUi("grants:create", {
        ...req({ delegate: account }),
        validUntil: Math.floor(Date.now() / 1000) + 3600,
        proof: { password: "password-1" },
      }),
    ).rejects.toThrow(/this account/);
    await expect(
      wallet.handleUi("grants:revoke", { chainId: 1337, delegate: DELEGATE, proof: { password: "password-1" } }),
    ).rejects.toThrow(/no permission to remove/);
    expect(chain.pooled).toHaveLength(0);
  });
});

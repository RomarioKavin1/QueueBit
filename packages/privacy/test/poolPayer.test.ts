import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { arbitraryEntry, frameMode, getProfile, senderFrame, type FrameTx } from "@queuebit/frames";
import {
  DEFAULT_POOL_PAYER_LIMITS,
  MAX_SIGNATURES,
  MAX_UNPRICED_DATA_BYTES,
  PLACEHOLDER_PROOF,
  POOL_PAYER_ABI,
  VERIFY_DATA_LENGTH,
  buildPoolPayerTx,
  checkPoolPayerTx,
  contextOf,
  encodeVerifyCall,
  poolPayerWithdrawal,
  settleCall,
  type PoolPayerRules,
  type SolProof,
} from "../src/index.js";

const profile = getProfile("ethrex-eip8141-tracer");
const PAYER: Address = getAddress("0x5d54df2e7eca85ff23856a9ae865c63ae843d8b9");
const SENDER_KEY: Hex = `0x${"07".repeat(32)}`;
const SENDER = privateKeyToAddress(SENDER_KEY);
const RULES: PoolPayerRules = {
  scope: 777n,
  minPayStateGas: 183_600n,
  minSettleGas: 1_000_000n,
  minSettleStateGas: 1_000_000n,
  minRefundGas: 150_000n,
  minRefundStateGas: 183_600n,
};
const FEE = 7_896_333_520_000_000n;

function proofFor(w: { processooor: Address; data: Hex }, scope = RULES.scope, withdrawn = 5n * 10n ** 16n): SolProof {
  const s = [...PLACEHOLDER_PROOF.pubSignals] as bigint[];
  s[2] = withdrawn;
  s[3] = 99n;
  s[4] = 3n;
  s[6] = 2n;
  s[7] = contextOf(w, scope);
  return { ...PLACEHOLDER_PROOF, pubSignals: s as unknown as SolProof["pubSignals"] };
}

function good(o: { recipient?: Address; refundRecipient?: Address; fee?: bigint } = {}) {
  const w = poolPayerWithdrawal({
    payer: PAYER,
    recipient: o.recipient ?? SENDER,
    fee: o.fee ?? FEE,
    ...(o.refundRecipient ? { refundRecipient: o.refundRecipient } : {}),
  });
  const data = encodeVerifyCall(RULES.scope, w, proofFor(w), 7);
  return buildPoolPayerTx({
    profile,
    chainId: 1337n,
    sender: SENDER,
    payer: PAYER,
    verifyData: data,
    fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  });
}
const check = (tx: FrameTx, maxCost?: bigint) =>
  checkPoolPayerTx(profile, tx, { payer: PAYER, rules: RULES, ...(maxCost !== undefined ? { maxCost } : {}) });
const mutate = (tx: FrameTx, f: (t: FrameTx) => void) => {
  const t = structuredClone(tx);
  f(t);
  return t;
};

describe("PoolPayer frame building", () => {
  it("builds exactly [only_verify(sender), pay(PoolPayer.verify), DEFAULT settle(1), DEFAULT refund()] (v1, no tail)", () => {
    const tx = good();
    const V = frameMode(profile, "VERIFY");
    const D = frameMode(profile, "DEFAULT");
    expect(tx.frames.map((f) => [f.mode, f.target, f.flags])).toEqual([
      [V, null, 2],
      [V, PAYER, 1],
      [D, PAYER, 0],
      [D, PAYER, 0],
    ]);
    expect(tx.frames[1]!.limits).toEqual({
      execution: DEFAULT_POOL_PAYER_LIMITS.pay,
      state: DEFAULT_POOL_PAYER_LIMITS.payState,
    });
    expect(tx.frames[2]!.data).toBe(settleCall(1));
    expect(tx.frames[3]!.data).toBe(toFunctionSelector("refund()"));
    expect((tx.frames[1]!.data.length - 2) / 2).toBe(VERIFY_DATA_LENGTH);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.blobVersionedHashes).toEqual([]);
    expect(check(tx)).toEqual([]);
  });

  it("refuses to build with non-canonical verify calldata", () => {
    expect(() =>
      buildPoolPayerTx({
        profile,
        chainId: 1337n,
        sender: SENDER,
        payer: PAYER,
        verifyData: "0x1234",
        fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      }),
    ).toThrow(/836/);
  });
});

describe("shape check mirrors PoolPayer.verify (post-review rules)", () => {
  const cases: [string, (t: FrameTx) => void, RegExp][] = [
    ["pay flags not PAYMENT-only", (t) => void (t.frames[1]!.flags = 3), /APPROVE_PAYMENT/],
    ["pay state gas below MIN_PAY_STATE_GAS", (t) => void (t.frames[1]!.limits.state = 1n), /MIN_PAY_STATE_GAS/],
    ["no only_verify(sender) first", (t) => void t.frames.shift(), /only_verify|settle must name/],
    ["settle names the wrong frame", (t) => void (t.frames[2]!.data = settleCall(0)), /settle must name/],
    ["settle starved", (t) => void (t.frames[2]!.limits.execution = 10n), /settle.*execution gas/],
    ["settle as an atomic batch", (t) => void (t.frames[2]!.flags = 4), /settle.*flags/],
    ["refund not last", (t) => void t.frames.pop(), /settle and refund|refund/],
    [
      "refund starved (MIN_REFUND_GAS 150k)",
      (t) => void (t.frames[3]!.limits.execution = 149_999n),
      /refund.*execution gas/,
    ],
    ["a user tail frame", (t) => void t.frames.splice(3, 0, senderFrame(profile, { execution: 1n })), /no tail frames/],
    [
      "an ATOMIC_BATCH tail right before refund",
      (t) => void t.frames.splice(3, 0, senderFrame(profile, { execution: 1n, atomic: true })),
      /no tail frames/,
    ],
    ["blobs", (t) => void t.blobVersionedHashes.push(`0x01${"00".repeat(31)}`), /blobs/],
    [
      "too many signatures",
      (t) => void t.signatures.push(...Array(MAX_SIGNATURES).fill(t.signatures[0]!)),
      /signatures/,
    ],
    [
      "unpriced ARBITRARY witness > 2 KB",
      (t) => void t.signatures.push(arbitraryEntry(profile, MAX_UNPRICED_DATA_BYTES + 1)),
      /unpriced/,
    ],
    [
      "oversized only_verify data",
      (t) => void (t.frames[0]!.data = `0x${"ab".repeat(MAX_UNPRICED_DATA_BYTES + 1)}`),
      /unpriced/,
    ],
    ["a value frame", (t) => void (t.frames[3]!.value = 1n), /value/],
    ["a second VERIFY after pay", (t) => void t.frames.splice(2, 0, t.frames[0]!), /PREFIX-050|settle/],
  ];
  for (const [name, f, re] of cases) {
    it(`rejects: ${name}`, () => {
      const v = check(mutate(good(), f));
      expect(v.join("; ")).toMatch(re);
    });
  }

  it("rejects bad bindings: processooor, feeRecipient, self recipients, context, fee > withdrawn, fee < quote", () => {
    const bind = (w: { processooor: Address; data: Hex }, p = proofFor(w), scope = RULES.scope) =>
      check(mutate(good(), (t) => void (t.frames[1]!.data = encodeVerifyCall(scope, w, p, 7))));
    const w = poolPayerWithdrawal({ payer: PAYER, recipient: SENDER, fee: FEE });
    expect(bind({ ...w, processooor: SENDER }).join()).toMatch(/processooor/);
    expect(bind(poolPayerWithdrawal({ payer: SENDER, recipient: SENDER, fee: FEE })).join()).toMatch(
      /processooor|feeRecipient/,
    );
    expect(check(good({ recipient: PAYER })).join()).toMatch(/must not be PoolPayer/);
    expect(check(good({ refundRecipient: PAYER })).join()).toMatch(/must not be PoolPayer/);
    expect(bind(w, proofFor(poolPayerWithdrawal({ payer: PAYER, recipient: SENDER, fee: FEE - 1n }))).join()).toMatch(
      /context/,
    );
    expect(bind(w, proofFor(w), 778n).join()).toMatch(/scope/);
    expect(bind(w, proofFor(w, RULES.scope, FEE - 1n)).join()).toMatch(/exceeds the withdrawn/);
    expect(check(good(), FEE + 1n).join()).toMatch(/below the quote/);
    expect(check(good(), FEE)).toEqual([]);
  });
});

describe("agreement with contracts/src/privacy/PoolPayer.sol", () => {
  const SRC = new URL("../../../contracts/src/privacy/PoolPayer.sol", import.meta.url);
  const OUT = new URL("../../../contracts/out/PoolPayer.sol/PoolPayer.json", import.meta.url);

  it.skipIf(!existsSync(SRC))("the constants mirrored here equal the contract's", () => {
    const sol = readFileSync(SRC, "utf8");
    const c = (name: string) => BigInt(new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(sol)![1]!.replaceAll("_", ""));
    expect(c("VERIFY_DATA_LENGTH")).toBe(BigInt(VERIFY_DATA_LENGTH));
    expect(c("MAX_UNPRICED_DATA_BYTES")).toBe(BigInt(MAX_UNPRICED_DATA_BYTES));
    expect(c("MAX_SIGNATURES")).toBe(BigInt(MAX_SIGNATURES));
  });

  it.skipIf(!existsSync(OUT))("our ABI's selectors exist in the compiled PoolPayer", () => {
    const abi = JSON.parse(readFileSync(OUT, "utf8")).abi as Abi;
    const compiled = new Set(abi.filter((x) => x.type === "function").map((x) => toFunctionSelector(x)));
    for (const x of POOL_PAYER_ABI.filter((x) => x.type === "function"))
      expect(compiled.has(toFunctionSelector(x))).toBe(true);
  });
});

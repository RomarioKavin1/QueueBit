import { describe, expect, it } from "vitest";
import {
  BUDGETS,
  EIP8141,
  calldataFloorGas,
  calldataFloorTokens,
  fitsBudget,
  intrinsicGas,
  predictedGasUsed,
  prefixValidationGas,
  tightLimit,
  tokensIn,
  type TxShape,
} from "../src/floor.js";

/**
 * Independent transcription of the EIP-8141 Python (ethereum/EIPs af5ea76, eip-8141.md:495-560), kept deliberately
 * literal (byte loops, named constants) so it shares no code with src/floor.ts.
 */
const EIP = {
  FRAME_TX_INTRINSIC_COST: 12000,
  FRAME_TX_PER_FRAME_COST: 475,
  TX_VALUE_COST: 6000,
  STANDARD_TOKEN_COST: 4,
  TOTAL_COST_FLOOR_PER_TOKEN: 16,
};
type PyFrame = { data: Uint8Array; value: bigint; target: string | null };
type PySig = { scheme: 0 | 1 | 2; signer: Uint8Array; msg: Uint8Array; signature: Uint8Array };
const signature_gas = (s: PySig) => [100, 2800, 6700][s.scheme]!;
function tokens_in(data: Uint8Array) {
  let zero_bytes = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0) zero_bytes += 1;
  const nonzero_bytes = data.length - zero_bytes;
  return zero_bytes + nonzero_bytes * 4;
}
const floor_tokens_in = (data: Uint8Array) => data.length * 4;
const calldata_cost = (data: Uint8Array) => EIP.STANDARD_TOKEN_COST * tokens_in(data);
function pyIntrinsicAndFloor(sender: string, frames: PyFrame[], sigs: PySig[]) {
  const value_cost = (f: PyFrame) => (f.value > 0n && f.target !== null && f.target !== sender ? EIP.TX_VALUE_COST : 0);
  const signature_verification_cost = sigs.reduce((a, s) => a + signature_gas(s), 0);
  const frame_data_cost = frames.reduce((a, f) => a + calldata_cost(f.data), 0);
  const signature_bytes_tokens = (s: PySig) =>
    s.msg.length === 0 ? floor_tokens_in(s.signature) : tokens_in(s.signature);
  const signature_data_cost = sigs.reduce(
    (a, s) => a + calldata_cost(s.signer) + calldata_cost(s.msg) + EIP.STANDARD_TOKEN_COST * signature_bytes_tokens(s),
    0,
  );
  const value_transfer_cost = frames.reduce((a, f) => a + value_cost(f), 0);
  const frame_tx_intrinsic_gas =
    EIP.FRAME_TX_INTRINSIC_COST +
    frames.length * EIP.FRAME_TX_PER_FRAME_COST +
    frame_data_cost +
    signature_data_cost +
    signature_verification_cost +
    value_transfer_cost;
  const calldata_floor_tokens =
    frames.reduce((a, f) => a + floor_tokens_in(f.data), 0) +
    sigs.reduce((a, s) => a + floor_tokens_in(s.signer) + floor_tokens_in(s.msg) + floor_tokens_in(s.signature), 0);
  const calldata_floor_gas =
    EIP.FRAME_TX_INTRINSIC_COST +
    frames.length * EIP.FRAME_TX_PER_FRAME_COST +
    signature_verification_cost +
    value_transfer_cost +
    EIP.TOTAL_COST_FLOOR_PER_TOKEN * calldata_floor_tokens;
  return { frame_tx_intrinsic_gas, calldata_floor_gas };
}

const SENDER = "0x00000000000000000000000000000000000000aa";
const schemeName = ["ARBITRARY", "SECP256K1", "P256"] as const;
function toShape(frames: PyFrame[], sigs: PySig[]): TxShape {
  return {
    frames: frames.map((f) => ({
      data: f.data,
      valueToOther: f.value > 0n && f.target !== null && f.target !== SENDER,
      hasValue: f.value > 0n,
      limits: { execution: 0n, state: 0n },
    })),
    signatures: sigs.map((s) => ({
      scheme: schemeName[s.scheme],
      signerLen: s.signer.length,
      msgLen: s.msg.length,
      sigLen: s.signature.length,
      sigBytes: s.signature,
      signerBytes: s.signer,
    })),
  };
}

// deterministic PRNG so failures reproduce
let seed = 0x1234567;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const bytes = (n: number, zeroBias = 0.3) =>
  Uint8Array.from({ length: n }, () => (rnd(1000) < zeroBias * 1000 ? 0 : 1 + rnd(255)));

describe("EIP-8141 gas math", () => {
  it("matches the EIP text on 500 random transactions", () => {
    for (let t = 0; t < 500; t++) {
      const frames: PyFrame[] = Array.from({ length: 1 + rnd(5) }, () => ({
        data: bytes(rnd(300)),
        value: rnd(3) === 0 ? BigInt(1 + rnd(10)) : 0n,
        target: rnd(2) ? null : rnd(2) ? SENDER : "0x00000000000000000000000000000000000000bb",
      }));
      const sigs: PySig[] = Array.from({ length: rnd(4) }, () => {
        const scheme = rnd(3) as 0 | 1 | 2;
        return {
          scheme,
          signer: scheme === 0 ? new Uint8Array() : rnd(2) ? bytes(20, 0) : new Uint8Array(),
          msg: rnd(4) === 0 ? bytes(32, 0) : new Uint8Array(),
          signature: bytes(scheme === 0 ? rnd(9000) : scheme === 1 ? 65 : 128),
        };
      });
      const py = pyIntrinsicAndFloor(SENDER, frames, sigs);
      const shape = toShape(frames, sigs);
      expect(intrinsicGas(shape)).toBe(py.frame_tx_intrinsic_gas);
      expect(calldataFloorGas(shape)).toBe(py.calldata_floor_gas);
    }
  });

  it("reproduces the plan's hand-computed C13 floor (2 frames, ARBITRARY, one value frame): 255,082", () => {
    const shape: TxShape = {
      frames: [
        { data: new Uint8Array(), valueToOther: false, limits: { execution: 0n, state: 0n } },
        { data: new Uint8Array(), valueToOther: true, limits: { execution: 0n, state: 0n } },
      ],
      signatures: [{ scheme: "ARBITRARY", signerLen: 0, msgLen: 0, sigLen: 3688 }],
    };
    expect(calldataFloorGas(shape)).toBe(12_000 + 2 * 475 + 100 + 6_000 + 64 * 3688);
    expect(calldataFloorGas(shape)).toBe(255_082);
    expect(calldataFloorTokens(shape)).toBe(4 * 3688);
  });

  it("floor is 64 gas per byte for zero and non-zero bytes alike; the intrinsic is not", () => {
    const mk = (b: number): TxShape => ({
      frames: [{ data: new Uint8Array(100).fill(b), valueToOther: false, limits: { execution: 0n, state: 0n } }],
      signatures: [],
    });
    expect(calldataFloorGas(mk(0))).toBe(calldataFloorGas(mk(7)));
    expect(calldataFloorGas(mk(7)) - (12_000 + 475)).toBe(6_400);
    expect(intrinsicGas(mk(0))).toBe(12_000 + 475 + 4 * 100);
    expect(intrinsicGas(mk(7))).toBe(12_000 + 475 + 16 * 100);
    expect(tokensIn(Uint8Array.from([0, 1, 0, 2]))).toBe(10);
  });

  it("elided (empty-msg) witnesses are priced uniformly in the intrinsic, others are weighted", () => {
    const sig = new Uint8Array(1000); // all zero
    const elided: TxShape = {
      frames: [],
      signatures: [{ scheme: "ARBITRARY", signerLen: 0, msgLen: 0, sigLen: 1000, sigBytes: sig }],
    };
    const explicit: TxShape = {
      frames: [],
      signatures: [{ scheme: "ARBITRARY", signerLen: 0, msgLen: 32, sigLen: 1000, sigBytes: sig }],
    };
    expect(intrinsicGas(elided)).toBe(12_000 + 100 + 16 * 1000);
    expect(intrinsicGas(explicit)).toBe(12_000 + 100 + 4 * 4 * 32 + 4 * 1000);
  });

  it("devnet pricing (ethrex 9aa3645d) adds the EIP-8250 nonce calldata: the leanSphincs-s Path A receipt", () => {
    // tx 0xa75ff3c4…650c on the local chain-1337 devnet: frames [0x01] and [0x03‖20-byte address], one 4,164-byte
    // ARBITRARY witness, nonce_keys [0], nonce_seq 0 -> nonce calldata c1 80 80 (3 bytes). Receipt gasUsed 281,146.
    const shape: TxShape = {
      frames: [
        { data: Uint8Array.of(1), valueToOther: false, limits: { execution: 68_000n, state: 0n } },
        {
          data: Uint8Array.from([3, ...new Uint8Array(20).fill(0x97)]),
          valueToOther: false,
          limits: { execution: 60_000n, state: 0n },
        },
      ],
      signatures: [{ scheme: "ARBITRARY", signerLen: 0, msgLen: 0, sigLen: 4164 }],
      nonceCalldata: Uint8Array.of(0xc1, 0x80, 0x80),
    };
    const used = [
      { execution: 43_724n, state: 0n },
      { execution: 12_289n, state: 0n },
    ];
    const eip = predictedGasUsed(shape, used);
    const dev = predictedGasUsed(shape, used, 16, "ethrex-1337");
    expect(eip.floorBound).toBe(true);
    expect(eip.gasUsed).toBe(280_954n);
    expect(dev.gasUsed).toBe(281_146n);
    expect(dev.gasUsed - eip.gasUsed).toBe(3n * 64n);
  });

  it("execution-bound transactions pay intrinsic + frame gas + state", () => {
    const shape: TxShape = {
      frames: [{ data: new Uint8Array(4), valueToOther: false, limits: { execution: 2_000_000n, state: 10n } }],
      signatures: [{ scheme: "ARBITRARY", signerLen: 0, msgLen: 0, sigLen: 100 }],
    };
    const p = predictedGasUsed(shape, [{ execution: 1_500_000n, state: 7n }]);
    expect(p.floorBound).toBe(false);
    expect(p.gasUsed).toBe(BigInt(intrinsicGas(shape)) + 1_500_000n + 7n);
    expect(() => predictedGasUsed(shape, [])).toThrow();
  });

  it("budget arithmetic", () => {
    expect(BUDGETS).toEqual([100_000, 250_000, 1_000_000, 2_500_000]);
    expect(fitsBudget(99_900n, EIP8141.SIG_COST.ARBITRARY, 100_000)).toBe(true);
    expect(fitsBudget(99_901n, EIP8141.SIG_COST.ARBITRARY, 100_000)).toBe(false);
    // tightLimit keeps the 1/64 a frame retains across STATICCALL, rounded up to 1,000
    expect(tightLimit(63_000n)).toBe(66_000n);
    expect(tightLimit(63_000n) >= 63_000n + 63_000n / 64n).toBe(true);
    const shape: TxShape = {
      frames: [
        { data: new Uint8Array(), valueToOther: false, limits: { execution: 80_000n, state: 0n } },
        { data: new Uint8Array(), valueToOther: false, limits: { execution: 1_000_000n, state: 0n } },
      ],
      signatures: [
        { scheme: "ARBITRARY", signerLen: 0, msgLen: 0, sigLen: 10 },
        { scheme: "SECP256K1", signerLen: 20, msgLen: 0, sigLen: 65 },
      ],
    };
    expect(prefixValidationGas(shape, 1)).toBe(80_000n + 100n + 2_800n);
  });
});

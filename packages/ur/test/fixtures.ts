import { C13_SCHEME_ID, ROLE, TX_TYPE, type SignRequest, type SignatureResponse } from "../src/index.js";

/** Deterministic pseudo-random bytes (xorshift32), so failures reproduce. */
export function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

export function bytes(n: number, seed: number): Uint8Array {
  const r = prng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
}

export const hex = (b: Uint8Array): `0x${string}` =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

export const fullRequest = (payloadLen = 1200): SignRequest => ({
  requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
  chainId: 1337n,
  txType: TX_TYPE.frameTx,
  payload: hex(bytes(payloadLen, 7)),
  role: ROLE.vault,
  schemeId: C13_SCHEME_ID,
  sigIndex: 0,
  expectedPk: hex(bytes(32, 9)),
  origin: "https://app.uniswap.org",
  profileId: "ethrex-eip8141-tracer",
  intent: {
    action: "send",
    summary: "Send 250 USDC to 0xab…cd",
    erc7730Ref: "leaked/account/v1#vaultExecute",
    recipient: hex(bytes(20, 11)),
    amount: 250_000_000n,
    token: hex(bytes(20, 12)),
  },
  policy: {
    account: hex(bytes(20, 13)),
    capUsdPerDay: 50_000_000n,
    perTxMaxUsd: 20_000_000n,
    timelockDelay: 172_800n,
    timelockThresholdUsd: 1_000_000_000n,
    maxFeeWeiPerTx: 2_000_000_000_000_000n,
    maxHotFrames: 4,
    tokens: [
      { token: "0x0000000000000000000000000000000000000000", decimals: 18, usdPerToken: 3_000_000_000n },
      { token: hex(bytes(20, 12)), decimals: 6, usdPerToken: 1_000_000n },
    ],
  },
});

export const minimalRequest = (): SignRequest => ({
  requestId: "00000000-0000-4000-8000-000000000001",
  chainId: 1n,
  txType: TX_TYPE.frameTx,
  payload: "0x06c0",
  role: ROLE.recovery,
  schemeId: C13_SCHEME_ID,
  sigIndex: 0,
  expectedPk: hex(bytes(32, 1)),
  profileId: "eip8141-current",
});

/** A canonical low-s secp256k1 signature shape (not a real signature; the schema checks form only). */
export const fakeSecp = (form: "vrs" | "rsv"): `0x${string}` => {
  const r = "11".repeat(32);
  const s = "22".repeat(32);
  return form === "vrs" ? `0x01${r}${s}` : `0x${r}${s}1b`;
};

export const signatureResponse = (): SignatureResponse => ({
  requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
  schemeId: C13_SCHEME_ID,
  witness: hex(bytes(3688, 21)),
  payerSig: fakeSecp("vrs"),
});

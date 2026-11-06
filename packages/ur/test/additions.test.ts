import { describe, expect, it } from "vitest";
import {
  C13_SCHEME_ID,
  ROLE,
  TX_TYPE,
  UR_TYPES,
  UrReceiver,
  UrSchemaError,
  decodeByType,
  decodeRecoveryChallenge,
  decodeSignRequest,
  encodeRecoveryChallenge,
  encodeSignRequest,
  randomUuid,
  singlePartUr,
  type SignRequest,
} from "../src/index.js";
import { bytes, fullRequest, hex, minimalRequest } from "./fixtures.js";

/** Additions of 2026-11-06 (backward compatible): tx-type 3 + key 14, and `ur:leaked-recovery-challenge`. */

const executorRequest = (): SignRequest => ({
  requestId: randomUuid(),
  chainId: 31337n,
  txType: TX_TYPE.roleExecutor7579,
  payload: hex(bytes(420, 5)),
  role: ROLE.vault,
  schemeId: C13_SCHEME_ID,
  expectedPk: hex(bytes(32, 6)),
  verifyingContract: hex(bytes(20, 8)),
  origin: "LEAKED extension",
  intent: { action: "send", recipient: hex(bytes(20, 9)), amount: 5n },
});

describe("tx-type 3 (LeakedRoleExecutor role call)", () => {
  it("round-trips, with key 14 lower-cased", () => {
    const r = executorRequest();
    expect(decodeSignRequest(encodeSignRequest(r))).toEqual(r);
    const rec: SignRequest = { ...r, role: ROLE.recovery };
    expect(decodeSignRequest(encodeSignRequest(rec)).role).toBe(ROLE.recovery);
  });

  it("requires the scheme, the expected pk and the executor", () => {
    for (const k of ["schemeId", "expectedPk", "verifyingContract"] as const) {
      const r = executorRequest();
      delete r[k];
      expect(() => encodeSignRequest(r)).toThrow(UrSchemaError);
    }
  });

  it("refuses frame-only and typed-data-only keys, and the guardian role", () => {
    expect(() => encodeSignRequest({ ...executorRequest(), sigIndex: 0 })).toThrow(/tx-type 3/u);
    expect(() => encodeSignRequest({ ...executorRequest(), profileId: "ethrex-eip8141-tracer" })).toThrow(/tx-type 3/u);
    expect(() => encodeSignRequest({ ...executorRequest(), payer: hex(bytes(20, 1)) })).toThrow(/tx-type 3/u);
    expect(() => encodeSignRequest({ ...executorRequest(), role: ROLE.guardian })).toThrow(UrSchemaError);
  });

  it("key 14 is refused on the existing tx-types (old requests unchanged)", () => {
    expect(() => encodeSignRequest({ ...fullRequest(), verifyingContract: hex(bytes(20, 1)) })).toThrow(/tx-type 3/u);
    const old = minimalRequest();
    expect(decodeSignRequest(encodeSignRequest(old))).toEqual(old);
  });

  it("a short executor address is refused", () => {
    expect(() => encodeSignRequest({ ...executorRequest(), verifyingContract: hex(bytes(19, 1)) })).toThrow(
      UrSchemaError,
    );
  });
});

describe("leaked-recovery-challenge", () => {
  const c = { requestId: randomUuid(), recoveryPk: hex(bytes(32, 4)) };

  it("round-trips and decodes by type", () => {
    const cbor = encodeRecoveryChallenge(c);
    expect(decodeRecoveryChallenge(cbor)).toEqual(c);
    expect(decodeByType(UR_TYPES.recoveryChallenge, cbor)).toEqual({ type: UR_TYPES.recoveryChallenge, value: c });
  });

  it("travels as a single-part UR", () => {
    const text = singlePartUr(UR_TYPES.recoveryChallenge, encodeRecoveryChallenge(c));
    expect(text.toLowerCase().startsWith("ur:leaked-recovery-challenge/")).toBe(true);
    const r = new UrReceiver([UR_TYPES.recoveryChallenge]).receive(text);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.decoded.value).toEqual(c);
  });

  it("rejects a short key and unknown keys", () => {
    expect(() => encodeRecoveryChallenge({ ...c, recoveryPk: hex(bytes(31, 1)) })).toThrow(UrSchemaError);
    const extra = encodeRecoveryChallenge(c);
    // map(2) → map(3) with an unknown key 3 appended: 0xa2 … → 0xa3 … 03 00
    const tampered = new Uint8Array([0xa3, ...extra.subarray(1), 0x03, 0x00]);
    expect(() => decodeRecoveryChallenge(tampered)).toThrow(UrSchemaError);
  });
});

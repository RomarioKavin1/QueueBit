import { Tag, encode } from "cbor2";
import { describe, expect, it } from "vitest";
import {
  C13_SCHEME_ID,
  LEAN_SPHINCS_S_SCHEME_ID,
  ROLE,
  TX_TYPE,
  UrSchemaError,
  decodePqKey,
  decodeRecoveryTest,
  decodeSignRequest,
  decodeSignature,
  encodePqKey,
  encodeRecoveryTest,
  encodeSignRequest,
  encodeSignature,
  randomUuid,
  recoveryTestChallenge,
  recoveryTestChallengeOf,
} from "../src/index.js";
import { bytes, fakeSecp, fullRequest, hex, minimalRequest, signatureResponse } from "./fixtures.js";

const raw = (m: Map<number, unknown>) => encode(m, { cde: true });

/** The CBOR map of a valid request, to mutate in negative tests. */
function requestMap(): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, new Tag(37, new Uint8Array(16).fill(1))],
    [2, 1337],
    [3, 6],
    [4, new Uint8Array([0x06, 0xc0])],
    [5, 1],
    [6, bytes(32, 1)],
    [7, 0],
    [8, bytes(32, 2)],
    [10, "ethrex-eip8141-tracer"],
  ]);
}

describe("queuebit-sign-request", () => {
  it("round-trips every field", () => {
    const r = fullRequest();
    expect(decodeSignRequest(encodeSignRequest(r))).toEqual(r);
  });

  it("round-trips a minimal request", () => {
    const r = minimalRequest();
    expect(decodeSignRequest(encodeSignRequest(r))).toEqual(r);
  });

  it("round-trips a typed-data (tx-type 2) request", () => {
    const typed = JSON.stringify({ types: {}, primaryType: "PrivacyPoolNote", domain: {}, message: {} });
    const r = {
      requestId: randomUuid(),
      chainId: 11155111n,
      txType: TX_TYPE.typedData,
      payload: hex(new TextEncoder().encode(typed)),
      role: ROLE.vault,
      payer: hex(bytes(20, 3)),
    } as const;
    expect(decodeSignRequest(encodeSignRequest(r))).toEqual(r);
  });

  it("encodes deterministically (same request, same bytes)", () => {
    expect(encodeSignRequest(fullRequest())).toEqual(encodeSignRequest(fullRequest()));
  });

  it("accepts the base map used by the negative tests", () => {
    expect(() => decodeSignRequest(raw(requestMap()))).not.toThrow();
  });

  const reject: [string, (m: Map<number, unknown>) => void, RegExp][] = [
    ["an unknown top-level key", (m) => m.set(99, 1), /unknown key 99/],
    ["a missing request-id", (m) => m.delete(1), /\.1: missing/],
    ["an untagged request-id", (m) => m.set(1, new Uint8Array(16)), /tag-37 UUID/],
    ["a 15-byte UUID", (m) => m.set(1, new Tag(37, new Uint8Array(15))), /tag-37 UUID/],
    ["a negative chain id", (m) => m.set(2, -1), /uint/],
    ["chain id 0", (m) => m.set(2, 0), /positive/],
    ["a text chain id", (m) => m.set(2, "1337"), /uint/],
    ["an unknown tx-type", (m) => m.set(3, 7), /unknown tx-type/],
    ["an empty payload", (m) => m.set(4, new Uint8Array()), /empty/],
    ["an oversized payload", (m) => m.set(4, new Uint8Array(70_000)), /longer than|larger than/],
    ["an unknown role", (m) => m.set(5, 4), /unknown role/],
    ["a 31-byte scheme id", (m) => m.set(6, new Uint8Array(31)), /expected 32 bytes/],
    ["sig-index 64", (m) => m.set(7, 64), /at most 63/],
    ["a missing expected-pk", (m) => m.delete(8), /\.8: required/],
    ["a missing profile-id on a frame tx", (m) => m.delete(10), /\.10: required/],
    ["an upper-case profile-id", (m) => m.set(10, "Eip8141"), /invalid format/],
    ["a payer on a frame tx", (m) => m.set(13, new Uint8Array(20)), /only allowed for tx-type 2/],
    ["a bidi override in origin", (m) => m.set(9, "https://evil‮.com"), /bidi/],
    ["an unknown intent key", (m) => m.set(11, new Map([[9, "x"]])), /unknown key 9/],
    ["a 19-byte intent recipient", (m) => m.set(11, new Map([[4, new Uint8Array(19)]])), /expected 20 bytes/],
    [
      "duplicate pinned tokens",
      (m) =>
        m.set(
          12,
          new Map([
            [
              6,
              [
                new Map<number, unknown>([
                  [1, new Uint8Array(20)],
                  [2, 18],
                  [3, 1],
                ]),
                new Map<number, unknown>([
                  [1, new Uint8Array(20)],
                  [2, 18],
                  [3, 2],
                ]),
              ],
            ],
          ]),
        ),
      /duplicate token/,
    ],
    [
      "decimals above 36",
      (m) =>
        m.set(
          12,
          new Map([
            [
              6,
              [
                new Map<number, unknown>([
                  [1, new Uint8Array(20)],
                  [2, 77],
                  [3, 1],
                ]),
              ],
            ],
          ]),
        ),
      /at most 36/,
    ],
  ];
  for (const [what, mutate, msg] of reject) {
    it(`rejects ${what}`, () => {
      const m = requestMap();
      mutate(m);
      expect(() => decodeSignRequest(raw(m))).toThrow(msg);
    });
  }

  it("rejects a typed-data request without a payer, or with frame-tx keys", () => {
    const m = requestMap();
    m.set(3, 2);
    m.set(4, new TextEncoder().encode("{}"));
    expect(() => decodeSignRequest(raw(m))).toThrow(/required for tx-type 2/);
    m.set(13, new Uint8Array(20));
    expect(() => decodeSignRequest(raw(m))).toThrow(/not allowed for tx-type 2/);
  });

  it("rejects a typed-data payload that is not UTF-8 JSON", () => {
    const m = new Map<number, unknown>([
      [1, new Tag(37, new Uint8Array(16))],
      [2, 1],
      [3, 2],
      [4, new Uint8Array([0xff, 0xfe])],
      [5, 1],
      [13, new Uint8Array(20)],
    ]);
    expect(() => decodeSignRequest(raw(m))).toThrow(/UTF-8 JSON/);
  });

  describe("byte-level malformations", () => {
    const good = encodeSignRequest(minimalRequest());
    it("rejects truncated CBOR", () => {
      for (let n = 0; n < good.length; n++) expect(() => decodeSignRequest(good.subarray(0, n))).toThrow(UrSchemaError);
    });
    it("rejects trailing bytes", () => {
      expect(() => decodeSignRequest(Uint8Array.from([...good, 0x00]))).toThrow(UrSchemaError);
    });
    it("rejects a non-preferred integer encoding", () => {
      // 0x18 0x05 is a one-byte-argument encoding of 5; preferred form is 0x05.
      const m = requestMap();
      const b = raw(m);
      const i = b.indexOf(0x05); // key 5 (role) -> rewrite as 0x18 0x05
      const bad = Uint8Array.from([...b.subarray(0, i), 0x18, 0x05, ...b.subarray(i + 1)]);
      expect(() => decodeSignRequest(bad)).toThrow(/deterministic|canonical/);
    });
    it("rejects unsorted map keys", () => {
      const bad = encode(
        new Map<number, unknown>([
          [2, 1],
          [1, new Tag(37, new Uint8Array(16))],
        ]),
      );
      expect(() => decodeSignRequest(bad)).toThrow(/deterministic|canonical/);
    });
    it("rejects an indefinite-length map", () => {
      expect(() => decodeSignRequest(Uint8Array.from([0xbf, 0x01, 0x01, 0xff]))).toThrow(UrSchemaError);
    });
    it("rejects floats and undefined", () => {
      expect(() => decodeSignRequest(Uint8Array.from([0xa1, 0x02, 0xf9, 0x3c, 0x00]))).toThrow(UrSchemaError);
      expect(() => decodeSignRequest(Uint8Array.from([0xa1, 0x02, 0xf7]))).toThrow(UrSchemaError);
    });
    it("rejects a top-level array", () => {
      expect(() => decodeSignRequest(encode([1, 2, 3]))).toThrow(/expected a CBOR map/);
    });
    it("survives random garbage without throwing anything but UrSchemaError", () => {
      for (let seed = 1; seed < 400; seed++) {
        const g = bytes(1 + (seed % 97), seed);
        try {
          decodeSignRequest(g);
        } catch (e) {
          expect(e).toBeInstanceOf(UrSchemaError);
        }
      }
    });
    it("survives single-byte corruptions of a valid request", () => {
      const ok = encodeSignRequest(fullRequest(64));
      for (let i = 0; i < ok.length; i++) {
        const b = ok.slice();
        b[i] = b[i]! ^ 0x40;
        try {
          decodeSignRequest(b);
        } catch (e) {
          expect(e).toBeInstanceOf(UrSchemaError);
        }
      }
    });
  });

  it("refuses to encode an invalid request", () => {
    expect(() => encodeSignRequest({ ...minimalRequest(), requestId: "not-a-uuid" })).toThrow(UrSchemaError);
    expect(() => encodeSignRequest({ ...minimalRequest(), sigIndex: undefined })).toThrow(/required/);
    expect(() => encodeSignRequest({ ...minimalRequest(), schemeId: "0x1234" })).toThrow(/32 bytes/);
  });
});

describe("queuebit-signature", () => {
  it("round-trips a Path B response", () => {
    const s = signatureResponse();
    expect(decodeSignature(encodeSignature(s))).toEqual(s);
  });
  it("round-trips a Path A response (no payer sig)", () => {
    const { payerSig: _p, ...s } = signatureResponse();
    expect(decodeSignature(encodeSignature(s))).toEqual(s);
  });
  it("round-trips a typed-data response", () => {
    const s = { requestId: randomUuid(), typedSig: fakeSecp("rsv") };
    expect(decodeSignature(encodeSignature(s))).toEqual(s);
  });
  it("rejects a C13 witness of the wrong length", () => {
    expect(() => encodeSignature({ ...signatureResponse(), witness: hex(bytes(3687, 1)) })).toThrow(/3688/);
  });
  it("rejects a witness without a scheme id, and an empty response", () => {
    expect(() => encodeSignature({ ...signatureResponse(), schemeId: undefined })).toThrow(/required with a witness/);
    expect(() => encodeSignature({ requestId: randomUuid() })).toThrow(/needs a witness/);
  });
  it("rejects a high-s or wrong-v payer signature", () => {
    const highS = `0x00${"11".repeat(32)}${"ff".repeat(32)}` as const;
    expect(() => encodeSignature({ ...signatureResponse(), payerSig: highS })).toThrow(/low-s/);
    expect(() => encodeSignature({ ...signatureResponse(), payerSig: fakeSecp("rsv") })).toThrow(/low-s/);
  });
  it("rejects a witness together with a typed-data signature", () => {
    expect(() => encodeSignature({ ...signatureResponse(), payerSig: undefined, typedSig: fakeSecp("rsv") })).toThrow(
      /no witness/,
    );
  });
});

describe("queuebit-pq-key", () => {
  it("round-trips a Vault key with its payer address", () => {
    const k = { schemeId: C13_SCHEME_ID, pk: hex(bytes(32, 5)), role: ROLE.vault, payer: hex(bytes(20, 6)) } as const;
    expect(decodePqKey(encodePqKey(k))).toEqual(k);
  });
  it("round-trips a Recovery key with and without its payer address (the Recovery bootstrap)", () => {
    const k = {
      schemeId: C13_SCHEME_ID,
      pk: hex(bytes(32, 5)),
      role: ROLE.recovery,
      payer: hex(bytes(20, 6)),
    } as const;
    expect(decodePqKey(encodePqKey(k))).toEqual(k);
    const { payer: _p, ...noPayer } = k;
    expect(decodePqKey(encodePqKey(noPayer))).toEqual(noPayer);
  });
  it("rejects a short payer, and role 3", () => {
    expect(() =>
      encodePqKey({ schemeId: C13_SCHEME_ID, pk: hex(bytes(32, 5)), role: ROLE.recovery, payer: hex(bytes(19, 6)) }),
    ).toThrow(/payer/);
    const m = new Map<number, unknown>([
      [1, bytes(32, 1)],
      [2, bytes(32, 2)],
      [3, 3],
    ]);
    expect(() => decodePqKey(raw(m))).toThrow(/must be 1/);
  });
});

describe("queuebit-recovery-test", () => {
  const pk = hex(bytes(32, 8));
  const t = {
    requestId: randomUuid(),
    schemeId: C13_SCHEME_ID,
    recoveryPk: pk,
    witness: hex(bytes(3688, 2)),
    ok: true,
  } as const;
  it("round-trips", () => {
    expect(decodeRecoveryTest(encodeRecoveryTest(t))).toEqual(t);
  });
  it("rejects ok = false and a short witness", () => {
    const m = new Map<number, unknown>([
      [1, new Tag(37, new Uint8Array(16))],
      [2, bytes(32, 1)],
      [3, bytes(32, 2)],
      [4, new Uint8Array(3688)],
      [5, false],
    ]);
    expect(() => decodeRecoveryTest(raw(m))).toThrow(/must be true/);
    expect(() => encodeRecoveryTest({ ...t, witness: hex(bytes(100, 1)) })).toThrow(/3688/);
  });
  it("binds the challenge to scheme, key and request id", () => {
    const c = recoveryTestChallenge(C13_SCHEME_ID, pk, t.requestId);
    expect(c).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recoveryTestChallenge(C13_SCHEME_ID, pk, t.requestId)).toBe(c);
    expect(recoveryTestChallenge(C13_SCHEME_ID, hex(bytes(32, 9)), t.requestId)).not.toBe(c);
    expect(recoveryTestChallenge(C13_SCHEME_ID, pk, randomUuid())).not.toBe(c);
    expect(recoveryTestChallenge(hex(bytes(32, 3)), pk, t.requestId)).not.toBe(c);
  });
  it("v2: a payer address is carried and covered by the challenge; v1 stays as it was", () => {
    const payer = hex(bytes(20, 4));
    const v2 = { ...t, payer };
    expect(decodeRecoveryTest(encodeRecoveryTest(v2))).toEqual(v2);
    expect(encodeRecoveryTest(v2).length).toBe(encodeRecoveryTest(t).length + 22);
    const c1 = recoveryTestChallengeOf(t);
    const c2 = recoveryTestChallengeOf(v2);
    expect(c1).toBe(recoveryTestChallenge(C13_SCHEME_ID, pk, t.requestId));
    expect(c2).toBe(recoveryTestChallenge(C13_SCHEME_ID, pk, t.requestId, payer));
    expect(c2).not.toBe(c1);
    expect(recoveryTestChallengeOf({ ...v2, payer: hex(bytes(20, 5)) })).not.toBe(c2);
    // A leanSphincs-s test must carry a 4,164-byte witness.
    expect(() => encodeRecoveryTest({ ...t, schemeId: LEAN_SPHINCS_S_SCHEME_ID })).toThrow(/4164/);
  });
  it("pins the v2 challenge construction", () => {
    // keccak256("QueueBit recovery test v2" ‖ C13_SCHEME_ID ‖ 0x00…00 ‖ uuid 00000000-0000-4000-8000-000000000000 ‖
    // 0x00…01 (20 bytes)), cross-checked with Foundry: cast keccak $(cast concat-hex …)
    expect(
      recoveryTestChallenge(
        C13_SCHEME_ID,
        `0x${"00".repeat(32)}`,
        "00000000-0000-4000-8000-000000000000",
        `0x${"00".repeat(19)}01`,
      ),
    ).toMatchInlineSnapshot(`"0x5c0aa95c3b288a73a75cee8708509b1b7b425ddbe886307b3864e6b86c174b02"`);
  });
  it("pins the challenge construction", () => {
    // keccak256("QueueBit recovery test v1" ‖ C13_SCHEME_ID ‖ 0x00…00 ‖ uuid 00000000-0000-4000-8000-000000000000),
    // cross-checked with Foundry: cast keccak 0x5175657565426974…
    expect(
      recoveryTestChallenge(C13_SCHEME_ID, `0x${"00".repeat(32)}`, "00000000-0000-4000-8000-000000000000"),
    ).toMatchInlineSnapshot(`"0x3b845031bd4c206b21531c353adf08cb068b4409df816d655f85c9903bcf2495"`);
  });
});

describe("randomUuid", () => {
  it("is a v4 UUID", () => {
    for (let i = 0; i < 50; i++)
      expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

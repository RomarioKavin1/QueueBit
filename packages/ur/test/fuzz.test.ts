import { Tag, decode, encode } from "cbor2";
import { describe, expect, it } from "vitest";
import {
  AnimatedUr,
  C13_SCHEME_ID,
  ROLE,
  UR_TYPES,
  UrReceiver,
  UrSchemaError,
  decodeByType,
  encodePqKey,
  encodeRecoveryChallenge,
  encodeRecoveryTest,
  encodeSignRequest,
  encodeSignature,
  type UrType,
} from "../src/index.js";
import { bytes, fullRequest, hex, prng, signatureResponse } from "./fixtures.js";

/**
 * Fuzzing of the decoders and the fountain receiver. The contract under test: whatever the input, a decoder throws
 * `UrSchemaError` or returns a value that re-encodes to the same bytes; the receiver never throws and never completes
 * with bytes that differ from the message the first accepted part belonged to.
 */

const valid: Record<UrType, Uint8Array> = {
  [UR_TYPES.signRequest]: encodeSignRequest(fullRequest(300)),
  [UR_TYPES.signature]: encodeSignature(signatureResponse()),
  [UR_TYPES.pqKey]: encodePqKey({
    schemeId: C13_SCHEME_ID,
    pk: hex(bytes(32, 3)),
    role: ROLE.vault,
    payer: hex(bytes(20, 4)),
  }),
  [UR_TYPES.recoveryTest]: encodeRecoveryTest({
    requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
    schemeId: C13_SCHEME_ID,
    recoveryPk: hex(bytes(32, 5)),
    witness: hex(bytes(3688, 6)),
    ok: true,
  }),
  [UR_TYPES.recoveryChallenge]: encodeRecoveryChallenge({
    requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
    recoveryPk: hex(bytes(32, 5)),
  }),
};

function onlySchemaErrors(type: UrType, input: Uint8Array): void {
  try {
    decodeByType(type, input);
  } catch (e) {
    if (!(e instanceof UrSchemaError)) {
      throw new Error(`${type}: ${(e as Error).constructor.name}: ${(e as Error).message}`, { cause: e });
    }
  }
}

/** Random CBOR values of every shape the schema could meet: wrong types, huge sizes, deep nesting, odd tags. */
function randomValue(r: () => number, depth = 0): unknown {
  const k = Math.floor(r() * 12);
  switch (k) {
    case 0:
      return Math.floor(r() * 2 ** 32);
    case 1:
      return (1n << BigInt(Math.floor(r() * 300))) + BigInt(Math.floor(r() * 1000));
    case 2:
      return -Math.floor(r() * 1000);
    case 3:
      return bytes(Math.floor(r() * 5000), Math.floor(r() * 1e6));
    case 4:
      return "x".repeat(Math.floor(r() * 1000)) + (r() < 0.3 ? "‮" : "");
    case 5:
      return r() < 0.5;
    case 6:
      return new Tag(37, bytes(r() < 0.5 ? 16 : Math.floor(r() * 40), 1));
    case 7:
      return new Tag(Math.floor(r() * 100), randomValue(r, depth + 1));
    case 8:
      return depth > 4 ? 0 : Array.from({ length: Math.floor(r() * 6) }, () => randomValue(r, depth + 1));
    case 9: {
      if (depth > 4) return 0;
      const m = new Map<number, unknown>();
      for (let i = 0; i < Math.floor(r() * 6); i++) m.set(Math.floor(r() * 16), randomValue(r, depth + 1));
      return m;
    }
    case 10:
      return null;
    default:
      return Array.from({ length: 20_000 }, () => 0); // oversized array
  }
}

function tryEncode(v: unknown): Uint8Array | undefined {
  try {
    return encode(v, { cde: true });
  } catch {
    return undefined;
  }
}

describe("decoder fuzz: every UR type", () => {
  it("random bytes only ever raise UrSchemaError", () => {
    for (const type of Object.values(UR_TYPES)) {
      for (let seed = 1; seed < 300; seed++) onlySchemaErrors(type, bytes(1 + (seed % 131), seed * 7919));
    }
  });

  it("byte flips, truncations and insertions of a valid payload only ever raise UrSchemaError", () => {
    for (const type of Object.values(UR_TYPES)) {
      const ok = valid[type];
      const r = prng(type.length * 1001);
      for (let i = 0; i < 400; i++) {
        const b = ok.slice();
        const pos = Math.floor(r() * b.length);
        const op = Math.floor(r() * 3);
        let m: Uint8Array;
        if (op === 0) {
          b[pos] = b[pos]! ^ (1 << Math.floor(r() * 8));
          m = b;
        } else if (op === 1) m = b.slice(0, pos);
        else {
          m = new Uint8Array(b.length + 1);
          m.set(b.subarray(0, pos));
          m[pos] = Math.floor(r() * 256);
          m.set(b.subarray(pos), pos + 1);
        }
        onlySchemaErrors(type, m);
        // What is accepted must re-encode byte-exactly (no two encodings for one request).
        try {
          decodeByType(type, m);
        } catch {
          continue;
        }
        expect(encode(decode(m, { cde: true }), { cde: true })).toEqual(m);
      }
    }
  });

  it("structure-aware mutations (wrong types, oversized fields, nesting, odd tags) only ever raise UrSchemaError", () => {
    for (const type of Object.values(UR_TYPES)) {
      const r = prng(type.length * 7 + 1);
      const base = decode(valid[type], { cde: true, preferMap: true }) as Map<number, unknown>;
      for (let i = 0; i < 400; i++) {
        const m = new Map(base);
        const key = r() < 0.8 ? [...m.keys()][Math.floor(r() * m.size)]! : Math.floor(r() * 40);
        if (r() < 0.15) m.delete(key);
        else m.set(key, randomValue(r));
        // Also mutate inside a nested map (intent / policy / price entries) when there is one.
        for (const [k, v] of m) {
          if (v instanceof Map && r() < 0.5) {
            const inner = new Map(v as Map<number, unknown>);
            inner.set(Math.floor(r() * 10), randomValue(r));
            m.set(k, inner);
          }
        }
        const enc = tryEncode(m);
        if (enc) onlySchemaErrors(type, enc);
      }
    }
  });

  it("rejects CBOR nested deeper than the schema ever needs", () => {
    let v: unknown = 1;
    for (let i = 0; i < 100; i++) v = [v];
    const m = new Map<number, unknown>([[1, v]]);
    expect(() => decodeByType(UR_TYPES.signRequest, encode(m, { cde: true }))).toThrow(UrSchemaError);
  });

  it("rejects a sign request whose payload is at the size limit plus one, accepts one at the limit", () => {
    const big = fullRequest(64 * 1024);
    expect(() => encodeSignRequest(big)).not.toThrow();
    expect(() => encodeSignRequest(fullRequest(64 * 1024 + 1))).toThrow(UrSchemaError);
  });
});

// ---------------------------------------------------------------------------------------------------------------

function mutateText(s: string, r: () => number): string {
  const ops = Math.floor(r() * 4);
  const chars = s.split("");
  if (ops === 0)
    chars[Math.floor(r() * chars.length)] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-:"[Math.floor(r() * 39)]!;
  else if (ops === 1) chars.splice(Math.floor(r() * chars.length), 1 + Math.floor(r() * 10));
  else if (ops === 2) chars.splice(Math.floor(r() * chars.length), 0, "Z");
  else return s.slice(0, Math.floor(r() * s.length));
  return chars.join("");
}

describe("receiver fuzz", () => {
  const A = encodeSignRequest(fullRequest(1200));
  const B = encodeSignRequest({
    ...fullRequest(1200),
    requestId: "8f1c2a4e-8b3d-4c5e-9f00-1a2b3c4d5e6f",
    payload: hex(bytes(1200, 99)),
  });

  it("mutated parts never throw, and a completed message is always the original", () => {
    const r = prng(42);
    let completed = 0;
    for (let trial = 0; trial < 150; trial++) {
      const enc = new AnimatedUr(UR_TYPES.signRequest, A, { maxFragmentLength: 100 + Math.floor(r() * 300) });
      const rx = new UrReceiver([UR_TYPES.signRequest]);
      for (let i = 0; i < 80; i++) {
        const p = enc.nextPart();
        const text = r() < 0.3 ? mutateText(p, r) : p;
        const res = rx.receive(text);
        if (res.status === "complete") {
          expect(res.cbor).toEqual(A);
          completed++;
          break;
        }
        if (res.status === "error") throw new Error(`unexpected error on trial ${trial}: ${res.error.message}`);
      }
    }
    expect(completed).toBeGreaterThan(100);
  });

  it("parts of two messages with identical part counts, interleaved, never assemble into something else", () => {
    const r = prng(7);
    for (let trial = 0; trial < 60; trial++) {
      const len = 150 + Math.floor(r() * 250);
      const ea = new AnimatedUr(UR_TYPES.signRequest, A, { maxFragmentLength: len });
      const eb = new AnimatedUr(UR_TYPES.signRequest, B, { maxFragmentLength: len });
      expect(ea.partCount).toBe(eb.partCount);
      const rx = new UrReceiver([UR_TYPES.signRequest]);
      let done: Uint8Array | undefined;
      for (let i = 0; i < 120 && !done; i++) {
        const res = rx.receive(r() < 0.5 ? ea.nextPart() : eb.nextPart());
        if (res.status === "error") throw new Error(res.error.message);
        if (res.status === "complete") done = res.cbor;
      }
      // Either it completes with exactly one of the two originals, or it never completes. Never a blend.
      if (done) expect([hex(A), hex(B)]).toContain(hex(done));
    }
  });

  it("a part whose header lies about the message length or fragment size is ignored, not decoded", () => {
    const enc = new AnimatedUr(UR_TYPES.signRequest, A, { maxFragmentLength: 200 });
    const good = enc.nextPart();
    const rx = new UrReceiver([UR_TYPES.signRequest]);
    // Replace the sequence header "1-N" with an absurd count: the body no longer matches, so it must be ignored.
    const lie = good.replace(/\/1-\d+\//, "/1-1024/");
    const res = rx.receive(lie);
    expect(res.status).toBe("ignored");
    expect(rx.receive(good).status).toBe("progress");
  });

  it("garbage text of every shape is ignored, never thrown", () => {
    const r = prng(3);
    const rx = new UrReceiver([UR_TYPES.signRequest, UR_TYPES.signature]);
    const samples = [
      "",
      "ur:",
      "ur:leaked-sign-request/",
      "ur:leaked-sign-request/1-0/aaaa",
      "ur:leaked-sign-request/0-1/aaaa",
      "ur:leaked-sign-request/99999999999999999999-1/aaaa",
      "ur:leaked-sign-request/1-1/" + "a".repeat(5000),
      "UR:LEAKED-SIGN-REQUEST/" + "Z".repeat(100),
      "ur:leaked-sign-request/1-2/\u0000\u0000",
      "ur:bytes/aaaa",
      "‮ur:leaked-sign-request/aaaa",
    ];
    for (let i = 0; i < 300; i++)
      samples.push(mutateText("ur:leaked-sign-request/1-3/" + "abcdefghijklmnopqrstuvwxyz".repeat(10), r));
    for (const s of samples) {
      const res = rx.receive(s);
      expect(["ignored", "progress", "error"]).toContain(res.status);
    }
  });
});

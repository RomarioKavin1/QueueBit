import { describe, expect, it } from "vitest";
import {
  AnimatedUr,
  UR_TYPES,
  UrReceiver,
  encodeSignRequest,
  encodeSignature,
  singlePartUr,
  type ReceiveResult,
} from "../src/index.js";
import { fullRequest, prng, signatureResponse } from "./fixtures.js";

function feed(rx: UrReceiver, parts: Iterable<string>): { result: ReceiveResult; used: number } {
  let used = 0;
  let last: ReceiveResult = { status: "ignored", reason: "nothing fed" };
  for (const p of parts) {
    used++;
    last = rx.receive(p);
    if (last.status === "complete" || last.status === "error") return { result: last, used };
  }
  return { result: last, used };
}

function* stream(enc: AnimatedUr, keep: (i: number) => boolean, limit: number): Generator<string> {
  for (let i = 0; i < limit; i++) {
    const p = enc.nextPart();
    if (keep(i)) yield p;
  }
}

const requestCbor = encodeSignRequest(fullRequest(1200));
const signatureCbor = encodeSignature(signatureResponse());

describe("animated UR round trip", () => {
  it("emits upper-case parts in QR alphanumeric charset", () => {
    const enc = new AnimatedUr(UR_TYPES.signature, signatureCbor);
    for (const p of enc.parts(30)) expect(p).toMatch(/^UR:QUEUEBIT-SIGNATURE\/\d+-\d+\/[A-Z]+$/);
  });

  it("a C13 signature at the default 400-byte fragments is ~10 parts", () => {
    const enc = new AnimatedUr(UR_TYPES.signature, signatureCbor);
    expect(enc.partCount).toBe(Math.ceil(signatureCbor.length / 400));
    expect(enc.partCount).toBeGreaterThanOrEqual(9);
    expect(enc.partCount).toBeLessThanOrEqual(11);
  });

  it("round-trips a sign request at every fragment length from 10 to its full size", () => {
    for (let max = 10; max <= requestCbor.length + 10; max++) {
      const enc = new AnimatedUr(UR_TYPES.signRequest, requestCbor, { maxFragmentLength: max });
      const rx = new UrReceiver([UR_TYPES.signRequest]);
      const { result, used } = feed(
        rx,
        stream(enc, () => true, enc.partCount * 3),
      );
      expect(result.status, `fragment ${max}`).toBe("complete");
      if (result.status !== "complete") return;
      expect(result.cbor).toEqual(requestCbor);
      expect(used).toBe(enc.partCount); // lossless: exactly the pure parts
    }
  }, 120_000);

  it("round-trips a signature at every fragment length that fits a QR code (10..2000)", () => {
    for (let max = 10; max <= 2000; max++) {
      const enc = new AnimatedUr(UR_TYPES.signature, signatureCbor, { maxFragmentLength: max });
      const rx = new UrReceiver([UR_TYPES.signature]);
      const { result } = feed(
        rx,
        stream(enc, () => true, enc.partCount * 3),
      );
      expect(result.status, `fragment ${max}`).toBe("complete");
      if (result.status === "complete") expect(result.cbor).toEqual(signatureCbor);
    }
  }, 120_000);

  it("a single-part payload decodes from one QR", () => {
    const small = encodeSignRequest(fullRequest(40));
    const enc = new AnimatedUr(UR_TYPES.signRequest, small, { maxFragmentLength: 2000 });
    expect(enc.isSinglePart).toBe(true);
    expect(enc.nextPart()).toBe(singlePartUr(UR_TYPES.signRequest, small));
    const r = new UrReceiver([UR_TYPES.signRequest]).receive(enc.nextPart());
    expect(r.status).toBe("complete");
  });

  it("reports progress while collecting", () => {
    const enc = new AnimatedUr(UR_TYPES.signature, signatureCbor);
    const rx = new UrReceiver([UR_TYPES.signature]);
    const r1 = rx.receive(enc.nextPart());
    expect(r1).toMatchObject({ status: "progress", received: 1, total: enc.partCount });
    const r2 = rx.receive(enc.nextPart());
    expect(r2).toMatchObject({ status: "progress", received: 2 });
  });
});

describe("fountain loss", () => {
  it("completes with 30% of parts dropped (100 random trials per fragment size)", () => {
    for (const max of [100, 200, 400, 600]) {
      const used: number[] = [];
      for (let trial = 0; trial < 100; trial++) {
        const rand = prng(1000 * max + trial);
        const enc = new AnimatedUr(UR_TYPES.signature, signatureCbor, { maxFragmentLength: max });
        const rx = new UrReceiver([UR_TYPES.signature]);
        let shown = 0;
        const { result } = feed(
          rx,
          stream(
            enc,
            () => {
              shown++;
              return rand() >= 0.3;
            },
            enc.partCount * 20,
          ),
        );
        expect(result.status, `max ${max} trial ${trial}`).toBe("complete");
        if (result.status === "complete") expect(result.cbor).toEqual(signatureCbor);
        used.push(shown / enc.partCount);
      }
      used.sort((a, b) => a - b);
      // Frames displayed per original part before completion: the median must stay near the 1/0.7 information
      // bound and the tail bounded (plan §20 §4.2 expects 10–16 displayed frames for 10 parts at 80% success).
      const median = used[50]!;
      const p95 = used[95]!;
      expect(median).toBeLessThan(2.2);
      expect(p95).toBeLessThan(3.5);
    }
  }, 120_000);

  it("completes when every pure part is lost (fountain parts only)", () => {
    const enc = new AnimatedUr(UR_TYPES.signature, signatureCbor);
    const n = enc.partCount;
    const rx = new UrReceiver([UR_TYPES.signature]);
    const { result } = feed(
      rx,
      stream(enc, (i) => i >= n, n * 10),
    );
    expect(result.status).toBe("complete");
  });
});

describe("receiver robustness", () => {
  const enc = () => new AnimatedUr(UR_TYPES.signature, signatureCbor);

  it("ignores non-UR text and unknown UR types", () => {
    const rx = new UrReceiver([UR_TYPES.signature]);
    expect(rx.receive("hello").status).toBe("ignored");
    expect(rx.receive("https://example.com").status).toBe("ignored");
    expect(rx.receive("ur:crypto-psbt/lpadaxcfaxhlcy").status).toBe("ignored");
    expect(rx.receive("x".repeat(10_000)).status).toBe("ignored");
  });

  it("reports a known-but-unexpected type as an error (wrong screen)", () => {
    const rx = new UrReceiver([UR_TYPES.signRequest]);
    const r = rx.receive(enc().nextPart());
    expect(r.status).toBe("error");
  });

  it("ignores parts of a second message once a first one is in progress (stale animation)", () => {
    const a = enc();
    const other = encodeSignature({ ...signatureResponse(), requestId: "11111111-1111-4111-8111-111111111111" });
    const b = new AnimatedUr(UR_TYPES.signature, other);
    const rx = new UrReceiver([UR_TYPES.signature]);
    rx.receive(a.nextPart());
    for (const p of b.parts(b.partCount * 2)) {
      const r = rx.receive(p);
      expect(r.status).not.toBe("complete");
    }
    const { result } = feed(rx, a.parts(a.partCount * 3));
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.cbor).toEqual(signatureCbor);
  });

  it("ignores a part with a broken bytewords checksum", () => {
    const p = enc().nextPart();
    const last = p.at(-1) === "A" ? "B" : "A";
    const rx = new UrReceiver([UR_TYPES.signature]);
    expect(rx.receive(p.slice(0, -1) + last).status).toBe("ignored");
  });

  it("ignores a part whose header claims more parts than allowed", () => {
    const rx = new UrReceiver([UR_TYPES.signature]);
    const p = enc()
      .nextPart()
      .toLowerCase()
      .replace(/\/1-(\d+)\//, "/1-5000/");
    expect(rx.receive(p).status).toBe("ignored");
  });

  it("reports a schema-invalid complete payload as an error, not a result", () => {
    // A complete UR of the right type whose CBOR is not a signature map.
    const bogus = singlePartUr(UR_TYPES.signature, Uint8Array.from([0x83, 0x01, 0x02, 0x03]));
    const r = new UrReceiver([UR_TYPES.signature]).receive(bogus);
    expect(r.status).toBe("error");
  });

  it("accepts lower- and upper-case and surrounding whitespace", () => {
    const small = encodeSignRequest(fullRequest(16));
    const s = singlePartUr(UR_TYPES.signRequest, small);
    expect(new UrReceiver([UR_TYPES.signRequest]).receive(`  ${s.toLowerCase()}\n`).status).toBe("complete");
  });

  it("returns complete once, then ignores until reset", () => {
    const small = encodeSignRequest(fullRequest(16));
    const s = singlePartUr(UR_TYPES.signRequest, small);
    const rx = new UrReceiver([UR_TYPES.signRequest]);
    expect(rx.receive(s).status).toBe("complete");
    expect(rx.receive(s).status).toBe("ignored");
    rx.reset();
    expect(rx.receive(s).status).toBe("complete");
  });
});

describe("encoder limits", () => {
  it("refuses a fragment length whose parts would not fit one QR code", () => {
    expect(() => new AnimatedUr(UR_TYPES.signature, signatureCbor, { maxFragmentLength: 5000 })).toThrow(
      /does not fit/,
    );
  });
});

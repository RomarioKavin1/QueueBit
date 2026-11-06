import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  RelayClient,
  RelayError,
  fingerprintWords,
  linkSecretOf,
  manualCode,
  newChannel,
  open,
  pairLink,
  parseManualCode,
  parsePairFragment,
  requestChannel,
  seal,
} from "../src/index.js";

describe("relay-client", () => {
  it("round-trips a pairing link and the manual code", () => {
    const c = newChannel();
    const link = pairLink("https://x.example/companion", c);
    expect(link).toBe(`https://x.example/companion/#pair=${c.id}.${c.key}`);
    expect(parsePairFragment(link)).toEqual(c);
    expect(parsePairFragment(new URL(link).hash)).toEqual(c);
    expect(parseManualCode(manualCode(c))).toEqual(c);
    expect(parseManualCode(link)).toEqual(c);
    expect(parsePairFragment("#pair=short.key")).toBeNull();
    expect(parseManualCode("QB1.nope")).toBeNull();
  });

  it("encrypts end to end: the relay's bytes don't contain the message, and only the key opens them", async () => {
    const c = newChannel();
    const msg = { t: "sig" as const, cbor: `0x${"ab".repeat(3800)}` };
    const box = await seal(c, msg);
    expect(new TextDecoder().decode(box)).not.toContain("abab");
    expect(await open(c, box)).toEqual(msg);
    await expect(open(newChannel(), box)).rejects.toBeInstanceOf(RelayError);
    // Bound to its channel: the same key on another id fails.
    await expect(open({ ...c, id: newChannel().id }, box)).rejects.toThrow(/failed its check/u);
    const tampered = box.slice();
    tampered[20]! ^= 1;
    await expect(open(c, tampered)).rejects.toThrow(/failed its check/u);
  });

  it("refuses messages over 16 KB and unknown shapes", async () => {
    const c = newChannel();
    await expect(seal(c, { t: "sig", cbor: `0x${"00".repeat(MAX_MESSAGE_BYTES)}` })).rejects.toThrow(/too big/u);
    const evil = await seal(c, { t: "nope" } as never);
    await expect(open(c, evil)).rejects.toThrow(/doesn't understand/u);
  });

  it("derives one channel per request from the link secret", () => {
    const c = newChannel();
    const s = linkSecretOf(c);
    expect(s).not.toBe(c.key);
    const a = requestChannel(s, "6f1c3b2a-0000-4000-8000-000000000001");
    expect(requestChannel(s, "6F1C3B2A-0000-4000-8000-000000000001")).toEqual(a);
    expect(requestChannel(s, "6f1c3b2a-0000-4000-8000-000000000002").id).not.toBe(a.id);
    expect(requestChannel(linkSecretOf(newChannel()), "6f1c3b2a-0000-4000-8000-000000000001").id).not.toBe(a.id);
  });

  it("makes the same 4 words from the same key on both ends", () => {
    const w = fingerprintWords("0xAbC", "0x1234");
    expect(w).toHaveLength(4);
    expect(fingerprintWords("0xabc", "0x1234")).toEqual(w);
    expect(fingerprintWords("0xabd", "0x1234")).not.toEqual(w);
  });

  it("sends and long-polls through a fetch (in-memory relay stand-in)", async () => {
    const boxes = new Map<string, Uint8Array>();
    const fake: typeof fetch = async (input, init) => {
      const id = new URL(String(input)).pathname.split("/").pop()!;
      if (init?.method === "PUT") {
        if (boxes.has(id)) return new Response(null, { status: 409 });
        boxes.set(id, new Uint8Array(init.body as Uint8Array));
        return new Response(null, { status: 201 });
      }
      const b = boxes.get(id);
      return b ? new Response(b as BodyInit) : new Response(null, { status: 204 });
    };
    const client = new RelayClient("https://relay.example/relay/", fake);
    const c = newChannel();
    expect(await client.receiveOnce(c, { waitS: 0 })).toBeNull();
    await client.send(c, { t: "pair", ur: "ur:queuebit-pq-key/abc" });
    await expect(client.send(c, { t: "pair", ur: "x" })).rejects.toMatchObject({ code: "taken" });
    const ctl = new AbortController();
    expect(await client.waitFor(c, { signal: ctl.signal })).toEqual({ t: "pair", ur: "ur:queuebit-pq-key/abc" });
  });

  it("stops waiting on a channel someone else filled: the phone can't deliver there any more", async () => {
    const c = newChannel();
    const junk = await seal({ ...c, key: newChannel().key }, { t: "pair", ur: "ur:queuebit-pq-key/impostor" });
    let gets = 0;
    const fake: typeof fetch = async () => {
      gets++;
      return new Response(junk as BodyInit);
    };
    const client = new RelayClient("https://relay.example/relay/", fake);
    await expect(client.waitFor(c, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: "bad-message",
    });
    expect(gets).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { C13_SCHEME_ID, UrReceiver, decodePqKey, encodeSignature, fromHex, randomUuid, UR_TYPES } from "@queuebit/ur";
import { RelayClient, linkSecretOf, newChannel, open, requestChannel } from "@queuebit/relay-client";
import {
  MAX_LINKS,
  pairWords,
  relayAvailable,
  sendPairing,
  sendSignature,
  type BrowserLink,
} from "../src/core/relay.js";
import { pairingUr } from "../src/screens/Onboarding.js";

/** An in-memory relay: what was PUT, by channel id. */
function memoryRelay() {
  const boxes = new Map<string, Uint8Array>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const id = new URL(String(input)).pathname.split("/").pop()!;
    if (init?.method !== "PUT") return new Response(null, { status: 405 });
    if (boxes.has(id)) return new Response(null, { status: 409 });
    boxes.set(id, new Uint8Array(init.body as Uint8Array));
    return new Response(null, { status: 201 });
  };
  return { boxes, client: new RelayClient("https://relay.example/relay", fetchImpl) };
}

const PK = `0x${"ab".repeat(32)}` as const;
const PAYER = "0x00000000000000000000000000000000000000aa" as const;

describe("companion relay", () => {
  it("is off without a build-time relay URL or in offline mode", () => {
    expect(relayAvailable({}, "")).toBe(false);
    expect(relayAvailable({ offline: true }, "https://r.example/relay")).toBe(false);
    expect(relayAvailable({}, "https://r.example/relay")).toBe(true);
  });

  it("sends the pairing code over the pairing channel and keeps the link (newest first, capped)", async () => {
    const { boxes, client } = memoryRelay();
    const c = newChannel();
    const ur = pairingUr(PK, PAYER, C13_SCHEME_ID);
    const old: BrowserLink[] = Array.from({ length: MAX_LINKS }, (_, i) => ({ secret: `s${i}`, linkedAt: i }));
    const links = await sendPairing(client, c, ur, old, 99);
    expect(links).toHaveLength(MAX_LINKS);
    expect(links[0]).toEqual({ secret: linkSecretOf(c), linkedAt: 99 });
    const msg = await open(c, boxes.get(c.id)!);
    expect(msg.t).toBe("pair");
    const r = new UrReceiver([UR_TYPES.pqKey]).receive((msg as { ur: string }).ur);
    if (r.status !== "complete") throw new Error("not a pairing code");
    const k = decodePqKey(r.cbor);
    expect(k.pk).toBe(PK);
    expect(pairWords(PK, PAYER)).toHaveLength(4);
  });

  it("sends a signature on the channel derived from its request id, to every linked browser", async () => {
    const { boxes, client } = memoryRelay();
    const links = [newChannel(), newChannel()].map((c) => ({ secret: linkSecretOf(c), linkedAt: 1 }));
    const requestId = randomUuid();
    const sig = encodeSignature({ requestId, schemeId: C13_SCHEME_ID, witness: `0x${"01".repeat(3688)}` });
    expect(await sendSignature(client, links, sig)).toBe(2);
    const ch = requestChannel(links[1]!.secret, requestId);
    const m = await open(ch, boxes.get(ch.id)!);
    expect(m.t === "sig" && fromHex(m.cbor as `0x${string}`)).toEqual(sig);
    expect(await sendSignature(client, [], sig)).toBe(0);
    // Every send failing is an error the screen shows (the QR code stays as the fallback).
    await expect(sendSignature(client, links, sig)).rejects.toMatchObject({ code: "taken" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { RelayClient, newChannel, linkSecretOf, requestChannel } from "@queuebit/relay-client";
// @ts-expect-error: plain ESM without types
import { createRelay, listen } from "../src/relay.mjs";

type Relay = ReturnType<typeof createRelay>;
const ID = "A".repeat(22);
const q = (s = "") => new URLSearchParams(s);
const put = (r: Relay, id: string, body: Buffer, ip = "1.1.1.1") =>
  r.handle({ method: "PUT", path: `/relay/${id}`, query: q(), ip, body: async () => body });
const get = (r: Relay, id: string, wait = 0, ip = "1.1.1.1", onClose?: (f: () => void) => void) =>
  r.handle({ method: "GET", path: `/relay/${id}`, query: q(`wait=${wait}`), ip, ...(onClose ? { onClose } : {}) });

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
});

async function live(opts: Record<string, unknown> = {}) {
  const { server, port, relay } = await listen(opts, 0, "127.0.0.1");
  servers.push(server);
  return { client: new RelayClient(`http://127.0.0.1:${port}/relay`), relay: relay as Relay, port };
}

describe("relay server", () => {
  it("is end-to-end encrypted: the server holds only ciphertext, the client with the key reads it", async () => {
    const { client, relay } = await live();
    const c = newChannel();
    const ur = "ur:queuebit-pq-key/secret-looking-public-key";
    await client.send(c, { t: "pair", ur });
    const stored = relay.channels.get(c.id)!.body as Buffer;
    expect(stored.toString("latin1")).not.toContain("queuebit-pq-key");
    expect(stored.toString("latin1")).not.toContain(c.key);
    expect(await client.receiveOnce(c, { waitS: 0 })).toEqual({ t: "pair", ur });
    // The id alone (what the server knows) doesn't open it.
    await expect(client.receiveOnce({ id: c.id, key: newChannel().key }, { waitS: 0 })).rejects.toMatchObject({
      code: "bad-message",
    });
  });

  it("long-polls: a GET that waits gets the message as soon as the phone sends it", async () => {
    const { client } = await live();
    const c = requestChannel(linkSecretOf(newChannel()), "6f1c3b2a-0000-4000-8000-000000000001");
    const t0 = Date.now();
    const pending = client.receiveOnce(c, { waitS: 10 });
    await new Promise((r) => setTimeout(r, 200));
    await client.send(c, { t: "sig", cbor: `0x${"11".repeat(3700)}` });
    expect(await pending).toEqual({ t: "sig", cbor: `0x${"11".repeat(3700)}` });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("returns 204 after the wait when nothing came, and frees the waiter when the client leaves", async () => {
    const r = createRelay();
    const t0 = Date.now();
    expect((await get(r, ID, 1)).status).toBe(204);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    let close: () => void = () => undefined;
    const p = get(r, ID, 25, "1.1.1.1", (f) => (close = f));
    await new Promise((res) => setTimeout(res, 20));
    close();
    expect((await p).status).toBe(204);
    r.close();
  });

  it("is one-time: a second message to the same channel is refused, and a deleted channel stays closed", async () => {
    const r = createRelay();
    expect((await put(r, ID, Buffer.from("a"))).status).toBe(201);
    expect((await put(r, ID, Buffer.from("b"))).status).toBe(409);
    expect((await r.handle({ method: "DELETE", path: `/relay/${ID}`, query: q(), ip: "1" })).status).toBe(204);
    expect((await get(r, ID)).status).toBe(410);
    expect((await put(r, ID, Buffer.from("c"))).status).toBe(409);
    r.close();
  });

  it("caps messages at 16 KB (also over HTTP, before reading the body)", async () => {
    const r = createRelay();
    expect(
      (await r.handle({ method: "PUT", path: `/relay/${ID}`, query: q(), ip: "1", body: async () => null })).status,
    ).toBe(413);
    r.close();
    const { port } = await live();
    const res = await fetch(`http://127.0.0.1:${port}/relay/${ID}`, {
      method: "PUT",
      body: new Uint8Array(16 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    const ok = await fetch(`http://127.0.0.1:${port}/relay/${"B".repeat(22)}`, {
      method: "PUT",
      body: new Uint8Array(16 * 1024),
    });
    expect(ok.status).toBe(201);
  });

  it("expires messages after 5 minutes", async () => {
    let now = 1_000_000;
    const r = createRelay({ now: () => now });
    await put(r, ID, Buffer.from("hello"));
    now += 4 * 60_000;
    expect((await get(r, ID)).status).toBe(200);
    now += 61_000;
    expect((await get(r, ID)).status).toBe(204);
    r.sweep();
    expect(r.channels.size).toBe(0);
    // Expired: the channel may be written again (it is a new channel to the relay).
    expect((await put(r, ID, Buffer.from("again"))).status).toBe(201);
    r.close();
  });

  it("rate-limits per IP, without affecting other IPs", async () => {
    let now = 0;
    const r = createRelay({ now: () => now, rateBurst: 5, ratePerSec: 1 });
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await get(r, ID, 0, "6.6.6.6")).status);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect((await get(r, ID, 0, "7.7.7.7")).status).toBe(204);
    now += 3000;
    expect((await get(r, ID, 0, "6.6.6.6")).status).toBe(204);
    r.close();
  });

  it("caps writes per IP, channels held and open waits", async () => {
    const r = createRelay({ maxPutsPerIp: 2, rateBurst: 100, maxChannels: 3, maxWaitersPerIp: 1 });
    const id = (n: number) => String(n).padStart(22, "x");
    expect((await put(r, id(1), Buffer.from("1"))).status).toBe(201);
    expect((await put(r, id(2), Buffer.from("2"))).status).toBe(201);
    expect((await put(r, id(3), Buffer.from("3"))).status).toBe(429);
    expect((await put(r, id(3), Buffer.from("3"), "2.2.2.2")).status).toBe(201);
    expect((await put(r, id(4), Buffer.from("4"), "2.2.2.2")).status).toBe(503);
    const r2 = createRelay({ maxWaitersPerIp: 1 });
    const first = get(r2, id(9), 1);
    expect((await get(r2, id(8), 1)).status).toBe(429);
    expect((await first).status).toBe(204);
    r.close();
    r2.close();
  });

  it("rejects malformed channel ids and answers CORS preflights", async () => {
    const r = createRelay();
    expect((await get(r, "short")).status).toBe(400);
    expect((await get(r, "../../etc/passwd")).status).toBe(400);
    const pre = await r.handle({ method: "OPTIONS", path: `/relay/${ID}`, query: q(), ip: "1" });
    expect(pre.status).toBe(204);
    expect(pre.headers?.["access-control-allow-methods"]).toContain("PUT");
    r.close();
  });
});

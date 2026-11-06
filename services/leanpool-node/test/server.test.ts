import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, pad, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { AddressInfo } from "node:net";
import { encodeRaw, sigHash, txHash, type FrameTx } from "../src/frameTx.js";
import * as pq from "../src/leanpq.js";
import { buildTx8288 } from "../src/tx.js";
import { AdmittedButPending, MAX_POOL, Node8288 } from "../src/node.js";
import type { Chain8288, TxStatus } from "../src/node.js";
import { createRpcServer, handle } from "../src/server.js";
import { REGISTRY_ABI, jsonRpc, ringOf } from "../src/chain.js";

const addr = (n: number): Address => pad(toHex(n), { size: 20 });
let key: pq.PqKey;
const owners = new Map<string, Hex>();

function chain(
  submit: Chain8288["submit"] = async () => ({ status: "0x1", gasUsed: 51_000n }),
): Chain8288 & { posts: number } {
  const c = {
    posts: 0,
    async holdsKey(a: Address, vk: Hex) {
      return owners.get(a.toLowerCase())?.toLowerCase() === vk.toLowerCase();
    },
    async postRoot(root: Hex) {
      c.posts++;
      return { tx: keccak256(root), block: 7n, ring: 3 };
    },
    async ringPosition() {
      return null;
    },
    async attachProof(_root: Hex, proofHash: Hex) {
      return keccak256(proofHash);
    },
    submit,
  };
  return c;
}

async function signed(n: number) {
  const wallet = addr(0x5000 + n);
  owners.set(wallet.toLowerCase(), key.publicKey);
  const tx = buildTx8288({
    wallet,
    vk: key.publicKey,
    nonceKey: BigInt(n),
    nonceSeq: 0n,
    call: { to: addr(0xbb), value: 1n },
  });
  return { tx, raw: encodeRaw(tx), sig: await key.sign(sigHash(tx)) };
}

beforeAll(async () => {
  key = await pq.keyFromSeed(pad(toHex(91), { size: 32 }));
});

describe("leanpool_getTx follows a tx from intake to mined", () => {
  test("pooled → mined, with the mined hash, the batch and its ring position", async () => {
    const node = new Node8288({ chain: chain(), aggregate: true, name: "A" });
    const t = await signed(1);
    const sent = (await handle(node, "leanpool_sendTransaction", [{ raw: t.raw, sigs: [t.sig] }])) as { txHash: Hex };
    expect(sent.txHash).toBe(txHash(t.tx).toLowerCase());
    expect(await handle(node, "leanpool_getTx", [sent.txHash])).toEqual({ stage: "pooled" });
    await node.batchOnce();
    const s = (await handle(node, "leanpool_getTx", [sent.txHash])) as TxStatus;
    expect(s.stage).toBe("mined");
    expect(s.txHash).not.toBe(sent.txHash); // the witness changes the hash
    expect(s.batch).toMatchObject({ ring: 3, block: "7" });
    expect(s.gasUsed).toBe("51000");
  });

  test("submitted (in the alt mempool, not mined in time) and reverted", async () => {
    const pending = new Node8288({
      chain: chain(async () => {
        throw new AdmittedButPending("slow");
      }),
      aggregate: true,
      name: "P",
    });
    const t1 = await signed(2);
    const id1 = (
      (await handle(pending, "leanpool_sendTransaction", [{ raw: t1.raw, sigs: [t1.sig] }])) as { txHash: Hex }
    ).txHash;
    await pending.batchOnce();
    expect(((await handle(pending, "leanpool_getTx", [id1])) as TxStatus).stage).toBe("submitted");

    const reverted = new Node8288({
      chain: chain(async () => ({ status: "0x0", gasUsed: 90_000n })),
      aggregate: true,
      name: "R",
    });
    const t2 = await signed(3);
    const id2 = (
      (await handle(reverted, "leanpool_sendTransaction", [{ raw: t2.raw, sigs: [t2.sig] }])) as { txHash: Hex }
    ).txHash;
    await reverted.batchOnce();
    expect(((await handle(reverted, "leanpool_getTx", [id2])) as TxStatus).stage).toBe("reverted");
  });

  test("a sidecar refusal keeps the tx pooled, with the reason", async () => {
    const node = new Node8288({
      chain: chain(async () => {
        throw new Error("AA25 nonce");
      }),
      aggregate: true,
      name: "E",
    });
    const t = await signed(4);
    const id = ((await handle(node, "leanpool_sendTransaction", [{ raw: t.raw, sigs: [t.sig] }])) as { txHash: Hex })
      .txHash;
    await node.batchOnce();
    expect(await handle(node, "leanpool_getTx", [id])).toEqual({ stage: "pooled", lastError: "AA25 nonce" });
  });

  test("an unknown id is null; malformed params are refused", async () => {
    const node = new Node8288({ chain: chain(), aggregate: true, name: "A" });
    expect(await handle(node, "leanpool_getTx", [keccak256("0x01")])).toBeNull();
    await expect(handle(node, "leanpool_getTx", ["nope"])).rejects.toThrow(/poolId/);
    await expect(handle(node, "leanpool_sendTransaction", [{ raw: "0x01" }])).rejects.toThrow(/sigs/);
    await expect(handle(node, "eth_chainId", [])).rejects.toThrow(/unknown method/);
  });
});

describe("JSON-RPC over HTTP", () => {
  const node = new Node8288({ chain: chain(), aggregate: true, name: "http" });
  const server = createRpcServer({ node, maxBodyBytes: 64 * 1024, extraStatus: () => ({ registry: addr(0xee) }) });
  let url = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test("intake, status and health over HTTP; CORS for the extension", async () => {
    const t = await signed(5);
    const r = await jsonRpc<{ txHash: Hex }>(url, "leanpool_sendTransaction", [{ raw: t.raw, sigs: [t.sig] }]);
    expect(r.txHash).toBe(txHash(t.tx).toLowerCase());
    const st = await jsonRpc<{ pool: unknown[]; registry: string }>(url, "leanpool_status", []);
    expect(st.pool).toHaveLength(1);
    expect(st.registry).toBe(addr(0xee));
    const health = await fetch(url);
    expect(await health.json()).toEqual({ ok: true, name: "http" });
    expect(health.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("errors come back as JSON-RPC errors: bad signature, oversized body, bad JSON", async () => {
    const t = await signed(6);
    const other = await signed(7);
    await expect(jsonRpc(url, "leanpool_sendTransaction", [{ raw: t.raw, sigs: [other.sig] }])).rejects.toThrow(
      /does not verify/,
    );
    const big = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: ["0x" + "00".repeat(70_000)] }),
    });
    expect(((await big.json()) as { error: { message: string } }).error.message).toMatch(/above/);
    const bad = await fetch(url, { method: "POST", body: "{" });
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

test("ringOf reads the ring position from DepsRegistry's RootPosted event", () => {
  const root = keccak256("0x01");
  const topics = encodeEventTopics({
    abi: REGISTRY_ABI,
    eventName: "RootPosted",
    args: { root, aggregator: addr(0xa) },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint16" }, { type: "uint8" }], [2, 5]);
  expect(
    ringOf([
      { data: "0x", topics: [keccak256("0x99")] },
      { data, topics },
    ]),
  ).toBe(5);
  expect(() => ringOf([])).toThrow(/RootPosted/);
});

// Keep the tx type import used (FrameTx is part of the public surface the server hands out).
export type _Unused = FrameTx;

test("bounded memory: older STARKs are read back through loadStark; a full pool refuses intake", async () => {
  const onDisk = new Map<string, Hex>([[keccak256("0xbeef"), "0xbeef"]]);
  const node = new Node8288({
    chain: chain(),
    aggregate: true,
    name: "bounded",
    loadStark: (h) => onDisk.get(h) ?? null,
  });
  expect(await handle(node, "leanpool_getStark", [keccak256("0xbeef")])).toBe("0xbeef");
  expect(await handle(node, "leanpool_getStark", [keccak256("0x01")])).toBeNull();
  const t = await signed(9);
  for (let i = 0; i < MAX_POOL; i++) node.pool.set(`0x${i.toString(16).padStart(64, "0")}` as Hex, {} as never);
  await expect(node.intake(t.raw, [t.sig])).rejects.toThrow(/pool is full/u);
});

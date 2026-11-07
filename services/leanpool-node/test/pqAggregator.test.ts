// PQ mode: the aggregator identity is a PQAggregator contract that acts only on a C13 signature over an EIP-712
// digest. These tests run the node's PQ path (pqOps) against a fake PQAggregator + DepsRegistry written here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  bytesToHex,
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  hexToBytes,
  keccak256,
  pad,
  toHex,
} from "viem";
import type { Address, Hex } from "viem";
import * as c13 from "@queuebit/pq-signer";
import { REGISTRY_ABI, ringOf } from "../src/chain.js";
import { inlineSigner, readSecretKey, type C13Signer } from "../src/c13.js";
import { loadConfig } from "../src/config.js";
import { encodeRaw, sigHash } from "../src/frameTx.js";
import * as pq from "../src/leanpq.js";
import { Node8288, type Chain8288 } from "../src/node.js";
import { PQ_AGGREGATOR_ABI, attachDigest, postDigest, rotateDigest, withdrawDigest } from "../src/pqAggregator.js";
import { BudgetExhausted, SignatureLedger, pqOps, type PQChainIO } from "../src/pqOps.js";
import { buildTx8288 } from "../src/tx.js";

const addr = (n: number): Address => pad(toHex(n), { size: 20 });
const REGISTRY = addr(0xdead1);
const AGGREGATOR = addr(0xa66);
const VECTORS = new URL("../../../contracts/test/leanpool/fixtures/pq-aggregator.json", import.meta.url);

/** A stand-in signer: "signature" = keccak(pk ‖ digest), checked by the fake contract. */
function fakeSigner(pkByte: number): C13Signer & { signed: Hex[] } {
  const publicKey = pad(toHex(pkByte), { size: 32 });
  const signed: Hex[] = [];
  return {
    publicKey,
    signed,
    async sign(digest) {
      signed.push(digest);
      return keccak256(concat([publicKey, digest]));
    },
    async close() {},
  };
}

/** PQAggregator + DepsRegistry, in memory: the same checks as the contracts (nonce lanes, budget, root once). */
function fakeContract(o: { publicKey: Hex; budget?: bigint; verify?: (pk: Hex, digest: Hex, sig: Hex) => boolean }) {
  const st = {
    publicKey: o.publicKey,
    signaturesUsed: 0n,
    budget: o.budget ?? 1n << 22n,
    reserve: 16n,
    postNonce: 0n,
    attachNonce: 0n,
    posted: new Map<string, { count: number; wallets: Address[]; ring: number; proofHash?: Hex }>(),
    rings: new Map<string, Hex[]>(),
    batchCount: 0,
    txs: 0,
  };
  const verify = o.verify ?? ((pk: Hex, digest: Hex, sig: Hex) => sig === keccak256(concat([pk, digest])));
  const d = { chainId: 1337, aggregator: AGGREGATOR };
  const authorize = (digest: Hex, sig: Hex) => {
    if (st.signaturesUsed >= st.budget - st.reserve) throw new Error("reverted: BudgetExhausted()");
    if (!verify(st.publicKey, digest, sig)) throw new Error("reverted: BadSignature()");
    st.signaturesUsed++;
  };
  const io: PQChainIO = {
    chainId: 1337,
    registry: REGISTRY,
    aggregator: AGGREGATOR,
    async read(fn) {
      return {
        postNonce: st.postNonce,
        attachNonce: st.attachNonce,
        signaturesUsed: st.signaturesUsed,
        signatureBudget: st.budget,
        ADMIN_RESERVE: st.reserve,
      }[fn];
    },
    async publicKey() {
      return st.publicKey;
    },
    async isPosted(root) {
      return st.posted.has(root);
    },
    async send(data) {
      const call = decodeFunctionData({ abi: PQ_AGGREGATOR_ABI, data });
      const tx = keccak256(toHex(++st.txs));
      if (call.functionName === "post") {
        const [root, count, wallets, sig] = call.args;
        authorize(postDigest(d, { registry: REGISTRY, nonce: st.postNonce, root, count, wallets }), sig);
        if (st.posted.has(root)) throw new Error("reverted: RootExists()");
        st.postNonce++;
        const ring = st.batchCount++ % 8;
        st.posted.set(root, { count, wallets: [...wallets], ring });
        for (const w of wallets) {
          const r = st.rings.get(w.toLowerCase()) ?? Array<Hex>(8).fill(pad("0x", { size: 32 }));
          r[ring] = root;
          st.rings.set(w.toLowerCase(), r);
        }
        const topics = encodeEventTopics({
          abi: REGISTRY_ABI,
          eventName: "RootPosted",
          args: { root, aggregator: AGGREGATOR },
        }) as Hex[];
        const logs = [{ data: encodeAbiParameters([{ type: "uint16" }, { type: "uint8" }], [count, ring]), topics }];
        return { transactionHash: tx, blockNumber: 7n, gasUsed: 300_000n, logs };
      }
      if (call.functionName === "attachProof") {
        const [root, proofHash, sig] = call.args;
        authorize(attachDigest(d, { registry: REGISTRY, nonce: st.attachNonce, root, proofHash }), sig);
        st.attachNonce++;
        st.posted.get(root)!.proofHash = proofHash;
        return { transactionHash: tx, blockNumber: 8n, gasUsed: 250_000n, logs: [] };
      }
      throw new Error(`unexpected call ${call.functionName}`);
    },
  };
  return { st, io };
}

describe("digests", () => {
  test("equal the shared vectors (the Forge test checks the contract against the same file)", () => {
    const v = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
    const d = { chainId: v.chainId, aggregator: v.aggregator };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const big = (x: any) => ({ ...x, nonce: BigInt(x.nonce) });
    for (const name of ["post0", "post0ByB", "post1", "post1ByC", "pathPost"]) {
      const x = big(v.vectors[name]);
      expect(postDigest(d, x), name).toBe(x.digest);
    }
    expect(attachDigest(d, big(v.vectors.attach0))).toBe(v.vectors.attach0.digest);
    expect(rotateDigest(d, big(v.vectors.rotate0))).toBe(v.vectors.rotate0.digest);
    expect(withdrawDigest(d, { ...big(v.vectors.withdraw0), amount: BigInt(v.vectors.withdraw0.amount) })).toBe(
      v.vectors.withdraw0.digest,
    );
    // and the vectors' signatures verify under the named keys (pq-signer's verifier)
    expect(c13.verify(hexToBytes(v.keys.A), hexToBytes(v.vectors.post0.digest), hexToBytes(v.vectors.post0.sig))).toBe(
      true,
    );
  });

  test("bind the chain, the contract, the registry, the nonce and every field", () => {
    const d = { chainId: 1337, aggregator: AGGREGATOR };
    const m = { registry: REGISTRY, nonce: 0n, root: keccak256("0x01"), count: 2, wallets: [addr(1), addr(2)] };
    const base = postDigest(d, m);
    const variants = [
      postDigest({ ...d, chainId: 1 }, m),
      postDigest({ ...d, aggregator: addr(0xa67) }, m),
      postDigest(d, { ...m, registry: addr(0xdead2) }),
      postDigest(d, { ...m, nonce: 1n }),
      postDigest(d, { ...m, root: keccak256("0x02") }),
      postDigest(d, { ...m, count: 3 }),
      postDigest(d, { ...m, wallets: [addr(2), addr(1)] }),
      postDigest(d, { ...m, wallets: [addr(1)] }),
      attachDigest(d, { registry: REGISTRY, nonce: 0n, root: m.root, proofHash: m.root }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
});

describe("pqOps", () => {
  test("postRoot signs the Post digest at the contract's nonce and sends PQAggregator.post", async () => {
    const signer = fakeSigner(0x11);
    const { st, io } = fakeContract({ publicKey: signer.publicKey });
    const ops = pqOps(io, signer, new SignatureLedger(null));
    const root = keccak256("0x01");
    const r = await ops.postRoot(root, 3, [addr(1), addr(2)]);
    expect(ringOf(r.logs)).toBe(0);
    expect(st.rings.get(addr(2).toLowerCase())![0]).toBe(root);
    expect(signer.signed).toEqual([
      postDigest(
        { chainId: 1337, aggregator: AGGREGATOR },
        { registry: REGISTRY, nonce: 0n, root, count: 3, wallets: [addr(1), addr(2)] },
      ),
    ]);
    const r2 = await ops.postRoot(keccak256("0x02"), 1, [addr(1)]);
    expect(ringOf(r2.logs)).toBe(1);
    expect(st.postNonce).toBe(2n);
  });

  test("attachProof uses its own nonce lane", async () => {
    const signer = fakeSigner(0x11);
    const { st, io } = fakeContract({ publicKey: signer.publicKey });
    const ops = pqOps(io, signer, new SignatureLedger(null));
    const root = keccak256("0x01");
    await ops.postRoot(root, 1, [addr(1)]);
    await ops.postRoot(keccak256("0x02"), 1, [addr(1)]);
    await ops.attachProof(root, keccak256("0xaa"));
    expect(st.attachNonce).toBe(1n);
    expect(st.posted.get(root)!.proofHash).toBe(keccak256("0xaa"));
  });

  test("a root already posted is reported as RootExists without spending a signature", async () => {
    const signer = fakeSigner(0x11);
    const { io } = fakeContract({ publicKey: signer.publicKey });
    const ops = pqOps(io, signer, new SignatureLedger(null));
    const root = keccak256("0x01");
    await ops.postRoot(root, 1, [addr(1)]);
    await expect(ops.postRoot(root, 1, [addr(1)])).rejects.toThrow(/RootExists/);
    expect(signer.signed).toHaveLength(1);
  });

  test("a node holding another key cannot start, and its signatures would not verify", async () => {
    const signer = fakeSigner(0x22);
    const { io } = fakeContract({ publicKey: pad(toHex(0x11), { size: 32 }) });
    const ops = pqOps(io, signer, new SignatureLedger(null));
    await expect(ops.check()).rejects.toThrow(/holds the C13 key/);
    await expect(ops.postRoot(keccak256("0x01"), 1, [addr(1)])).rejects.toThrow(/BadSignature/);
  });

  test("the budget: refused at the post cap, counted on chain and in the node's own ledger", async () => {
    const signer = fakeSigner(0x11);
    const { st, io } = fakeContract({ publicKey: signer.publicKey, budget: 18n }); // 2 post signatures
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leanpool-pq-"));
    const file = path.join(dir, "pq-signatures.json");
    const ops = pqOps(io, signer, new SignatureLedger(file));
    await ops.postRoot(keccak256("0x01"), 1, [addr(1)]);
    await ops.postRoot(keccak256("0x02"), 1, [addr(1)]);
    await expect(ops.postRoot(keccak256("0x03"), 1, [addr(1)])).rejects.toBeInstanceOf(BudgetExhausted);
    expect(st.signaturesUsed).toBe(2n);
    // the ledger survives a restart, and counts a signature whose tx never landed
    const ledger = new SignatureLedger(file);
    expect(ledger.used(signer.publicKey)).toBe(2);
    const { st: st2, io: io2 } = fakeContract({ publicKey: signer.publicKey, budget: 18n });
    st2.signaturesUsed = 0n; // the chain saw none of them (say, all reverted)
    await expect(pqOps(io2, signer, ledger).postRoot(keccak256("0x04"), 1, [addr(1)])).rejects.toBeInstanceOf(
      BudgetExhausted,
    );
    fs.rmSync(dir, { recursive: true });
  });

  test("a real C13 signature: the inline signer signs the Post digest and pq-signer verifies it", async () => {
    const sk = c13.keygenFromSeedParts(new Uint8Array(32).fill(5), new Uint8Array(16).fill(6)).secretKey;
    const signer = inlineSigner(sk);
    const { st, io } = fakeContract({
      publicKey: signer.publicKey,
      verify: (pk, digest, sig) => c13.verify(hexToBytes(pk), hexToBytes(digest), hexToBytes(sig)),
    });
    const ops = pqOps(io, signer, new SignatureLedger(null));
    await ops.postRoot(keccak256("0x01"), 1, [addr(1)]);
    expect(st.postNonce).toBe(1n);
    await signer.close();
  });
});

describe("config and key loading", () => {
  const base = {
    LEANPOOL_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    LEANPOOL_RPC_URL: "http://rpc",
    LEANPOOL_SIDECAR_URL: "http://sidecar",
    LEANPOOL_REGISTRY: REGISTRY,
  };
  test("ECDSA mode stays the default; PQ mode needs the C13 key", () => {
    expect(loadConfig(base).pq).toBeNull();
    expect(() => loadConfig({ ...base, LEANPOOL_PQ_AGGREGATOR: AGGREGATOR })).toThrow(/LEANPOOL_PQ_KEY/);
    const cfg = loadConfig({ ...base, LEANPOOL_PQ_AGGREGATOR: AGGREGATOR, LEANPOOL_PQ_KEY_FILE: "/k.json" });
    expect(cfg.pq).toEqual({ aggregator: getAddress(AGGREGATOR), keyFile: "/k.json" });
  });

  test("the secret key comes from hex or a key file (raw hex or JSON), and is length-checked", () => {
    const sk = bytesToHex(new Uint8Array(64).fill(7));
    expect(bytesToHex(readSecretKey({ key: sk }))).toBe(sk);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leanpool-pq-"));
    fs.writeFileSync(path.join(dir, "k.json"), JSON.stringify({ secretKey: sk, publicKey: "0x" }));
    fs.writeFileSync(path.join(dir, "k.hex"), `${sk}\n`);
    expect(
      bytesToHex(
        readSecretKey(
          loadConfig({ ...base, LEANPOOL_PQ_AGGREGATOR: AGGREGATOR, LEANPOOL_PQ_KEY_FILE: path.join(dir, "k.json") })
            .pq!,
        ),
      ),
    ).toBe(sk);
    expect(bytesToHex(readSecretKey({ keyFile: path.join(dir, "k.hex") }))).toBe(sk);
    expect(() => readSecretKey({ key: "0x1234" })).toThrow(/64 bytes/);
    expect(() => readSecretKey({})).toThrow(/LEANPOOL_PQ_KEY/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("the node in PQ mode", () => {
  let wallet: pq.PqKey;
  beforeAll(async () => {
    wallet = await pq.keyFromSeed(pad(toHex(123), { size: 32 }));
  });

  test("a batch's root is posted through the PQAggregator into the wallet's ring, and its proof hash attached", async () => {
    const signer = fakeSigner(0x11);
    const { st, io } = fakeContract({ publicKey: signer.publicKey });
    const ops = pqOps(io, signer, new SignatureLedger(null));
    const sender = addr(0x3001);
    const submitted: Hex[] = [];
    // chain.ts's PQ glue: postRoot/attachProof through pqOps, the ring read from the registry's RootPosted event.
    const chain: Chain8288 = {
      async holdsKey(a, vk) {
        return a.toLowerCase() === sender.toLowerCase() && vk.toLowerCase() === wallet.publicKey.toLowerCase();
      },
      async postRoot(root, count, wallets) {
        const r = await ops.postRoot(root, count, wallets);
        return { tx: r.tx, block: r.block, ring: ringOf(r.logs) };
      },
      async ringPosition(root) {
        return st.posted.get(root)?.ring ?? null;
      },
      async attachProof(root, proofHash) {
        return (await ops.attachProof(root, proofHash)).tx;
      },
      async outcome() {
        return null;
      },
      async submit(tx) {
        submitted.push(sigHash(tx));
        return { status: "0x1", gasUsed: 60_000n };
      },
    };
    const node = new Node8288({ chain, aggregate: true, name: "pq" });
    const tx = buildTx8288({
      wallet: sender,
      vk: wallet.publicKey,
      nonceKey: 1n,
      nonceSeq: 0n,
      call: { to: addr(0xbb), value: 1n },
    });
    await node.intake(encodeRaw(tx), [await wallet.sign(sigHash(tx))]);
    const b = await node.batchOnce();
    expect(b).not.toBeNull();
    expect(st.rings.get(sender.toLowerCase())![0]).toBe(b!.root);
    expect(st.postNonce).toBe(1n);
    expect(submitted).toHaveLength(1);
    // the prover's attachProof goes through the PQ path too
    await chain.attachProof(b!.root, keccak256("0xbeef"));
    expect(st.posted.get(b!.root)!.proofHash).toBe(keccak256("0xbeef"));
    expect(signer.signed).toHaveLength(2);
  });
});

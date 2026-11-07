import { test, expect, beforeAll } from "vitest";
import { concat, decodeAbiParameters, keccak256, pad, toHex } from "viem";
import type { Address, Hex } from "viem";
import { encodeRaw, sigHash, txHash } from "../src/frameTx.js";
import type { FrameTx } from "../src/frameTx.js";
import { verifyProof } from "../src/merkle.js";
import * as pq from "../src/leanpq.js";
import { dependencies, encodeTriple, leafOf } from "../src/deps.js";
import { buildTx8288 } from "../src/tx.js";
import * as w from "../src/wrapper.js";
import { AdmittedButPending, Node8288 } from "../src/node.js";
import type { Chain8288 } from "../src/node.js";

const SLOW = process.env.LEANPOOL_SLOW === "1";
const addr = (n: number): Address => pad(toHex(n), { size: 20 });
const call = { to: addr(0xbb), value: 1n };
let key: pq.PqKey;
let stranger: pq.PqKey;
let third: pq.PqKey;
const wallets = new Map<string, Hex>();
/** ERC-8286 accounts: every PQ key their keystore holds. */
const accountKeys = new Map<string, Hex[]>();

type FakeChain = Chain8288 & {
  outcomes: Map<string, { status: string; gasUsed?: bigint } | { dropped: string } | null>;
  posted: { root: Hex; count: number; wallets: Address[] }[];
  proofs: { root: Hex; proofHash: Hex }[];
  submitted: FrameTx[];
};

function fakeChain(): FakeChain {
  const c: FakeChain = {
    posted: [] as { root: Hex; count: number; wallets: Address[] }[],
    proofs: [] as { root: Hex; proofHash: Hex }[],
    submitted: [] as FrameTx[],
    async holdsKey(a: Address, vk: Hex, validator: Address | null) {
      if (validator && validator.toLowerCase() !== addr(0xcc).toLowerCase()) return false; // not the keystore this node trusts
      const held = accountKeys.get(a.toLowerCase()) ?? [wallets.get(a.toLowerCase())];
      return held.some((k) => !!k && k.toLowerCase() === vk.toLowerCase());
    },
    async postRoot(root: Hex, count: number, wallets: Address[]) {
      // DepsRegistry refuses a root it already has (RootExists()).
      if (c.posted.some((p) => p.root === root)) throw new Error("Execution reverted with reason: 0x3293a2cf.");
      c.posted.push({ root, count, wallets });
      return { tx: keccak256(root), block: 1n, ring: (c.posted.length - 1) % 8 };
    },
    async ringPosition(root: Hex, ws: Address[]) {
      const i = c.posted.findIndex((p) => p.root === root);
      if (i < 0 || c.posted.length - i > 8) return null; // never posted, or pushed out of the 8-slot ring
      const p = c.posted[i]!;
      return ws.every((w) => p.wallets.some((x) => x.toLowerCase() === w.toLowerCase())) ? i % 8 : null;
    },
    async attachProof(root: Hex, proofHash: Hex) {
      c.proofs.push({ root, proofHash });
      return keccak256(proofHash);
    },
    outcomes: new Map<string, { status: string; gasUsed?: bigint } | { dropped: string } | null>(),
    async outcome(hash: Hex) {
      return c.outcomes.get(hash.toLowerCase()) ?? null;
    },
    async submit(tx: FrameTx) {
      c.submitted.push(tx);
      return { status: "0x1", gasUsed: 50_000n };
    },
  };
  return c;
}

/** Two nodes: A aggregates, B relays. Peers call each other directly. */
function pair() {
  const chainA = fakeChain();
  const chainB = fakeChain();
  const a = new Node8288({ chain: chainA, aggregate: true, name: "A" });
  const b = new Node8288({ chain: chainB, aggregate: false, name: "B" });
  a.peers = [(bytes) => b.receiveWrapper(bytes)];
  b.peers = [(bytes) => a.receiveWrapper(bytes)];
  return { a, b, chainA, chainB };
}

async function signedTx(n: number, k = key) {
  const wallet = addr(0x2000 + n);
  wallets.set(wallet.toLowerCase(), key.publicKey);
  const tx = buildTx8288({ wallet, vk: k.publicKey, nonceKey: BigInt(n), nonceSeq: 0n, call });
  return { tx, raw: encodeRaw(tx), sig: await k.sign(sigHash(tx)) };
}

beforeAll(async () => {
  key = await pq.keyFromSeed(pad(toHex(77), { size: 32 }));
  stranger = await pq.keyFromSeed(pad(toHex(78), { size: 32 }));
  third = await pq.keyFromSeed(pad(toHex(79), { size: 32 }));
});

test("intake verifies natively and checks the wallet's key", async () => {
  const { a } = pair();
  const ok = await signedTx(1);
  await a.intake(ok.raw, [ok.sig]);
  expect(a.pool.size).toBe(1);

  const bad = await signedTx(2);
  await expect(a.intake(bad.raw, [ok.sig])).rejects.toThrow(/does not verify/);
  const wrongKey = await signedTx(3, stranger);
  await expect(a.intake(wrongKey.raw, [wrongKey.sig])).rejects.toThrow(/key/);
  await expect(a.intake(ok.raw, [])).rejects.toThrow(/one signature/);
});

test("mode 0 gossip: B's txs reach A as a wrapper; a resend goes by hash; a tampered wrapper is rejected", async () => {
  const { a, b } = pair();
  const t1 = await signedTx(10);
  await b.intake(t1.raw, [t1.sig]);
  await b.broadcastMode0();
  expect(a.pool.has(txHash(t1.tx))).toBe(true);

  const t2 = await signedTx(11);
  await b.intake(t2.raw, [t2.sig]);
  const sent: Hex[] = [];
  b.peers = [async (bytes) => (sent.push(bytes), a.receiveWrapper(bytes))];
  await b.broadcastMode0();
  expect(w.decode(sent[0]).transactions).toContainEqual({ hash: txHash(t1.tx) });

  const tampered = w.decode(sent[0]);
  tampered.content.proofs = tampered.content.proofs!.map(() => t1.sig);
  const r = await a.receiveWrapper(w.encode(tampered));
  expect(r).toMatchObject({ accepted: false });
  expect(a.rejected.length).toBe(1);
});

test("the aggregator batches: binding check, postRoot, a witness that proves each tx's leaf, submit, prune", async () => {
  const { a, chainA } = pair();
  const items = await Promise.all([20, 21, 22].map((n) => signedTx(n)));
  for (const i of items) await a.intake(i.raw, [i.sig]);
  const batch = await a.batchOnce();
  expect(batch?.txs.length).toBe(3);
  expect(chainA.posted).toEqual([{ root: batch!.root, count: 3, wallets: items.map((i) => i.tx.sender) }]);
  expect(chainA.submitted.length).toBe(3);
  for (const tx of chainA.submitted) {
    const [root, ring, proof] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[]" }],
      tx.signatures[0].signature,
    );
    expect(root).toBe(batch!.root);
    expect(ring).toBe(0);
    expect(sigHash(tx)).toBe(sigHash(items.find((i) => i.tx.sender === tx.sender)!.tx)); // the witness is outside the sig hash
    expect(verifyProof(proof as Hex[], root, leafOf(dependencies(tx)[0]))).toBe(true);
  }
  expect(a.pool.size).toBe(0);
  expect(a.proofQueue.length).toBe(1);
});

test.skipIf(!SLOW)(
  "the batch proof: STARK hash attached on-chain, mode 1 wrapper accepted by the peer",
  async () => {
    const { a, b, chainA } = pair();
    const t = await signedTx(30);
    await a.intake(t.raw, [t.sig]);
    const batch = (await a.batchOnce())!;
    const proven = (await a.proveNext())!;
    expect(chainA.proofs).toEqual([{ root: batch.root, proofHash: keccak256(proven.agg.bytes) }]);
    expect(b.aggregates.at(-1)).toMatchObject({ txs: [txHash(t.tx)], kind: "peer" });
  },
  300_000,
);

test("a wallet the chain could not read is retried, not cached as unknown", async () => {
  const { a } = pair();
  const t = await signedTx(40);
  const sender = t.tx.sender.toLowerCase();
  const vkOf = wallets.get(sender)!;
  wallets.delete(sender);
  await expect(a.intake(t.raw, [t.sig])).rejects.toThrow(/key/);
  wallets.set(sender, vkOf);
  await a.intake(t.raw, [t.sig]);
  expect(a.pool.size).toBe(1);
});

test("intake takes only single-dependency txs: LeanWallet8288 declares exactly one", async () => {
  const { a } = pair();
  const t = await signedTx(41);
  const two = concat([t.tx.frames[0].data, encodeTriple({ dataHash: keccak256("0x01"), vk: key.publicKey })]);
  const tx = { ...t.tx, frames: [{ ...t.tx.frames[0], data: two }, t.tx.frames[1]] };
  await expect(a.intake(encodeRaw(tx), [t.sig, t.sig])).rejects.toThrow(/exactly one/);
});

test("a tx whose submission failed stays in the pool and is batched again", async () => {
  const { a, chainA } = pair();
  const t = await signedTx(42);
  await a.intake(t.raw, [t.sig]);
  const submit = chainA.submit;
  chainA.submit = async () => {
    throw new Error("sidecar down");
  };
  await a.batchOnce();
  expect(a.pool.has(txHash(t.tx))).toBe(true);
  chainA.submit = submit;
  const again = await a.batchOnce();
  expect(again?.txs).toEqual([txHash(t.tx)]);
  expect(a.pool.size).toBe(0);
});

test("a peer that was unreachable gets the full tx next time, not its hash", async () => {
  const { a, b } = pair();
  const t = await signedTx(43);
  await b.intake(t.raw, [t.sig]);
  let up = false;
  const seen: Hex[] = [];
  b.peers = [
    async (bytes) => {
      if (!up) throw new Error("connection refused");
      seen.push(bytes);
      return a.receiveWrapper(bytes);
    },
  ];
  await b.broadcastMode0();
  up = true;
  const t2 = await signedTx(44);
  await b.intake(t2.raw, [t2.sig]);
  await b.broadcastMode0();
  expect(w.decode(seen[0]).transactions.every((x) => "tx" in x)).toBe(true);
  expect(a.pool.has(txHash(t.tx))).toBe(true);
});

test("every STARK the node makes or receives goes to the persist hook; stored ones are served after a restart", async () => {
  const saved = new Map<Hex, Hex>();
  const chain = fakeChain();
  const fake = { bytes: "0xabcdef" as Hex, claims: [], handle: null };
  const a = new Node8288({ chain, aggregate: true, name: "A", persist: (h, b) => void saved.set(h, b) });
  a.prover = new (a.prover.constructor as new (o: { prove: () => Promise<unknown> }) => typeof a.prover)({
    prove: async () => fake,
  });
  const t = await signedTx(50);
  await a.intake(t.raw, [t.sig]);
  await a.batchOnce();
  await a.proveNext();
  expect([...saved.entries()]).toEqual([[keccak256("0xabcdef"), "0xabcdef"]]);

  const restarted = new Node8288({ chain, aggregate: true, name: "A2" });
  restarted.loadStarks(saved);
  expect(restarted.starks.get(keccak256("0xabcdef"))).toBe("0xabcdef");
});

test("a tx the alt mempool admitted but did not mine in time is not re-batched; it waits for its lane", async () => {
  const { a, chainA } = pair();
  const t = await signedTx(60);
  await a.intake(t.raw, [t.sig]);
  const submit = chainA.submit;
  chainA.submit = async () => {
    throw new AdmittedButPending("not mined within 300s");
  };
  const first = await a.batchOnce();
  expect(first?.txs).toEqual([txHash(t.tx)]);
  expect(a.pool.size).toBe(0); // out of the batching queue
  expect(await a.batchOnce()).toBeNull(); // nothing re-posted
  expect(chainA.posted.length).toBe(1);
  chainA.submit = submit;
});

test("a tx the alt mempool admitted and later dropped is reported refused, so the wallet frees its lane", async () => {
  const { a, chainA } = pair();
  const t = await signedTx(63);
  await a.intake(t.raw, [t.sig]);
  chainA.submit = async () => {
    throw new AdmittedButPending("not mined within 300s");
  };
  await a.batchOnce();
  const sent = a.txStatus(txHash(t.tx))!;
  expect(sent.stage).toBe("submitted");
  // Still in the mempool: nothing changes.
  await a.followPending();
  expect(a.txStatus(txHash(t.tx))!.stage).toBe("submitted");
  // The sidecar gave up on it ("relayed 4 times without being included in a block").
  chainA.outcomes.set(sent.txHash!.toLowerCase(), { dropped: "relayed 4 times without being included in a block" });
  await a.followPending();
  expect(a.txStatus(txHash(t.tx))).toMatchObject({
    stage: "refused",
    error: expect.stringContaining("relayed 4 times"),
  });
});

test("a tx the alt mempool admitted and later mined is reported mined", async () => {
  const { a, chainA } = pair();
  const t = await signedTx(64);
  await a.intake(t.raw, [t.sig]);
  chainA.submit = async () => {
    throw new AdmittedButPending("not mined within 300s");
  };
  await a.batchOnce();
  const sent = a.txStatus(txHash(t.tx))!;
  chainA.outcomes.set(sent.txHash!.toLowerCase(), { status: "0x1", gasUsed: 90_000n });
  await a.followPending();
  expect(a.txStatus(txHash(t.tx))).toMatchObject({ stage: "mined", gasUsed: "90000" });
});

test("a batch whose root is already posted is dropped, not retried forever", async () => {
  const { a, chainA } = pair();
  const t = await signedTx(61);
  await a.intake(t.raw, [t.sig]);
  chainA.postRoot = async () => {
    throw new Error("Execution reverted with reason: 0x3293a2cf.");
  };
  await expect(a.batchOnce()).rejects.toThrow(/already posted/);
  expect(a.pool.size).toBe(0);
  expect(await a.batchOnce()).toBeNull();
});

test("a tx retried after its delivery failed reuses its root, which is already posted", async () => {
  const { a, chainA } = pair();
  const t = await signedTx(62);
  await a.intake(t.raw, [t.sig]);
  const submit = chainA.submit;
  chainA.submit = async () => {
    throw new Error("Internal error"); // the sidecar refused it (e.g. its disk was full)
  };
  await a.batchOnce();
  expect(chainA.posted).toHaveLength(1);
  expect(a.pool.size).toBe(1); // kept for the next batch
  chainA.submit = submit;
  // The next batch rebuilds the same root: RootExists. The tx goes out with the posted root's witness instead.
  const second = await a.batchOnce();
  expect(second?.txs).toEqual([txHash(t.tx)]);
  expect(chainA.posted).toHaveLength(1);
  expect(chainA.submitted).toHaveLength(1);
  expect(a.pool.size).toBe(0);
});

test("each batch result names its LeanPool tx, and the batch records its ring position", async () => {
  const { a } = pair();
  const t = await signedTx(70);
  await a.intake(t.raw, [t.sig]);
  await a.batchOnce();
  const rec = a.batches.at(-1)!;
  expect(rec.ring).toBe(0);
  expect(rec.results).toEqual([expect.objectContaining({ poolTx: txHash(t.tx), status: "0x1" })]);
});

// ------------------------------------------------------------------ ERC-8286 accounts: several PQ signers -------
import { envelopeTx } from "./envelope.js";

async function accountTx(n: number, signers: pq.PqKey[], held = signers, keystore = addr(0xcc)) {
  const account = addr(0x3000 + n);
  accountKeys.set(
    account.toLowerCase(),
    held.map((k) => k.publicKey),
  );
  const plan = await envelopeTx({
    keystore,
    account,
    nonceKey: 1n,
    nonceSeq: 0n,
    call,
    signers: signers.map((k) => ({ kind: "PQ" as const, vk: k.publicKey, sign: (m: Hex) => k.sign(m) })),
  });
  return { tx: plan.tx, raw: encodeRaw(plan.tx), sigs: plan.pqSigs };
}

test("2-of-3 PQ: a keystore holding three PQ keys, two sign; one batch, witness (root, ring, proofs[]) in triple order", async () => {
  const { a, chainA } = pair();
  const t = await accountTx(1, [stranger, key], [key, stranger, third]); // triple order differs from the sorted dependency order
  await a.intake(t.raw, t.sigs);
  const batch = (await a.batchOnce())!;
  expect(chainA.posted).toEqual([{ root: batch.root, count: 2, wallets: [t.tx.sender] }]);
  const [sent] = chainA.submitted;
  const [root, ring, proofs] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[][]" }],
    sent.signatures[0].signature,
  );
  expect(root).toBe(batch.root);
  expect(ring).toBe(0);
  const sh = sigHash(t.tx);
  [stranger, key].forEach((k, i) =>
    expect(verifyProof(proofs[i] as Hex[], root, leafOf({ scheme: 0x10, dataHash: sh, vk: k.publicKey }))).toBe(true),
  );
  expect(a.proofQueue[0].sigs.length).toBe(2);
});

test("a keystore tx needs one signature per triple, in triple order, each by a key the account holds", async () => {
  const { a } = pair();
  const t = await accountTx(2, [stranger, key]);
  await expect(a.intake(t.raw, [t.sigs[0]])).rejects.toThrow(/one signature per/);
  await expect(a.intake(t.raw, [t.sigs[1], t.sigs[0]])).rejects.toThrow(/does not verify/);
  const notHeld = await accountTx(3, [stranger, key], [key]);
  await expect(a.intake(notHeld.raw, notHeld.sigs)).rejects.toThrow(/key/);
  // Keys held in another validator than the keystore this node reads: refused before any root is posted for them.
  const elsewhere = await accountTx(5, [key], [key], addr(0xdd));
  await expect(a.intake(elsewhere.raw, elsewhere.sigs)).rejects.toThrow(/key/);
});

test.skipIf(!SLOW)(
  "2-of-3 PQ, proven: the batch's STARK claims both signatures and the peer accepts the mode 1 wrapper",
  async () => {
    const { a, b, chainA } = pair();
    const t = await accountTx(6, [key, third], [key, stranger, third]);
    await a.intake(t.raw, t.sigs);
    const batch = (await a.batchOnce())!;
    const proven = (await a.proveNext())!;
    expect(proven.agg.claims.length).toBe(2);
    expect(chainA.proofs).toEqual([{ root: batch.root, proofHash: keccak256(proven.agg.bytes) }]);
    expect(b.aggregates.at(-1)).toMatchObject({ txs: [txHash(t.tx)], kind: "peer" });
  },
  300_000,
);

test("a peer's wrapper carrying a two-signer account tx is pooled with both signatures", async () => {
  const { a, b } = pair();
  const t = await accountTx(4, [key, stranger]);
  await b.intake(t.raw, t.sigs);
  await b.broadcastMode0();
  const pooled = a.pool.get(txHash(t.tx).toLowerCase() as Hex)!;
  expect(pooled.deps.length).toBe(2);
  expect(pooled.sigs.length).toBe(2);
});

import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import {
  AspIntegrityError,
  SyncIntegrityError,
  commitmentOf,
  createSignatureSecretManager,
  discoverNotes,
  findRootIndex,
  rootOf,
  spendable,
  staticAsp,
  syncPool,
  verifiedAspLabels,
  POOL_EVENTS,
  type RawLog,
} from "../src/index.js";
import { CHAIN, ENTRYPOINT, POOL, SimPool, fakeProvider, secretsFor, softwareSigner } from "./helpers.js";

const E = 10n ** 18n;

/** A pool with 3 of our deposits (one partially withdrawn once, then again) and 2 strangers' deposits. */
async function history() {
  const signer = softwareSigner();
  const pool = new SimPool();
  const d0 = await secretsFor(signer, 0, 0);
  const d1 = await secretsFor(signer, 1, 0);
  const d2 = await secretsFor(signer, 2, 0);
  pool.deposit(5n * E, 777n); // stranger
  const a = pool.deposit(1n * E, d0.precommitment);
  const b = pool.deposit(2n * E, d1.precommitment);
  pool.deposit(3n * E, 888n); // stranger
  const c = pool.deposit(4n * E, d2.precommitment);
  // Two withdrawals from deposit 1: (1,0) → (1,1) → (1,2).
  const c11 = await secretsFor(signer, 1, 1);
  pool.withdraw(5n * 10n ** 17n, d1.nullifierHash, commitmentOf(15n * 10n ** 17n, b.label, c11.precommitment));
  const c12 = await secretsFor(signer, 1, 2);
  pool.withdraw(5n * 10n ** 17n, c11.nullifierHash, commitmentOf(10n * 10n ** 17n, b.label, c12.precommitment));
  return { pool, signer, labels: { a: a.label, b: b.label, c: c.label } };
}

describe("sync (eth_getLogs paging, fail-closed root check)", () => {
  it("rebuilds the tree from paged logs and matches the pool root", async () => {
    const { pool } = await history();
    const p = fakeProvider(pool);
    const st = await syncPool(p, { pool: POOL, fromBlock: 100n, chunkSize: 2n });
    expect(st.leaves).toEqual(pool.leaves);
    expect(st.root).toBe(pool.root);
    expect(st.deposits).toHaveLength(5);
    expect(st.withdrawals).toHaveLength(2);
    expect(p.getLogsCalls).toBe(Math.ceil(Number(pool.block - 100n + 1n) / 2));
  });

  it("is incremental from a verified prior state", async () => {
    const { pool } = await history();
    const p = fakeProvider(pool);
    const first = await syncPool(p, { pool: POOL, fromBlock: 100n });
    pool.deposit(1n * E, 999n);
    const ranges: [bigint, bigint][] = [];
    const p2 = fakeProvider(pool, { onGetLogs: (f, t) => ranges.push([f, t]) });
    const second = await syncPool(p2, { pool: POOL, fromBlock: 100n, prior: first });
    expect(ranges[0]![0]).toBe(first.syncedTo + 1n);
    expect(second.leaves).toEqual(pool.leaves);
  });

  it("splits a page the node refuses", async () => {
    const { pool } = await history();
    const p = fakeProvider(pool, { maxRange: 3n });
    expect((await syncPool(p, { pool: POOL, fromBlock: 100n, chunkSize: 100n })).root).toBe(pool.root);
  });

  describe("tampered log sets are rejected", () => {
    const tamper = async (mut: (logs: RawLog[], pool: SimPool) => RawLog[]) => {
      const { pool } = await history();
      const logs = mut(structuredClone(pool.logs), pool);
      return syncPool(fakeProvider(pool, { logs: () => logs }), { pool: POOL, fromBlock: 100n });
    };
    const isLeaf = (l: RawLog) => l.topics[0] === POOL_EVENTS.LeafInserted;
    const leafLogs = (logs: RawLog[]) => logs.filter(isLeaf);

    it("a dropped LeafInserted log", async () => {
      await expect(tamper((l) => l.filter((x) => x !== leafLogs(l)[2]))).rejects.toThrow(SyncIntegrityError);
    });

    it("a dropped Withdrawn log (the leaf stays, the pool's history is incomplete) is caught by the leaf check", async () => {
      // Removing a whole withdrawal (its leaf and its event) leaves fewer leaves than the pool has.
      await expect(tamper((l) => l.slice(0, -2))).rejects.toThrow(/tree size/);
    });

    it("a substituted leaf with a self-consistent forged root", async () => {
      await expect(
        tamper((l, pool) => {
          // The attacker replaces leaf 3 and recomputes every later LeafInserted._root so the log set is consistent.
          const leaves = [...pool.leaves];
          leaves[3] = 123456789n;
          let i = 0;
          for (const log of l) {
            if (!isLeaf(log)) continue;
            const prefix = leaves.slice(0, i + 1);
            log.data = encodeAbiParameters(
              [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
              [BigInt(i + 1), leaves[i]!, rootOf(prefix)],
            );
            i++;
          }
          // Keep leaf 3's Deposited event consistent too: only the on-chain root can catch this.
          const deps = l.filter((x) => x.topics[0] === POOL_EVENTS.Deposited);
          const dep = deps[3]!;
          dep.data = ("0x" + 123456789n.toString(16).padStart(64, "0") + dep.data.slice(66)) as Hex;
          return l;
        }),
      ).rejects.toThrow(/computed root != pool's currentRoot/);
    });

    it("a lying LeafInserted root", async () => {
      await expect(
        tamper((l) => {
          const x = leafLogs(l)[1]!;
          x.data = (x.data.slice(0, -1) + (x.data.endsWith("0") ? "1" : "0")) as Hex;
          return l;
        }),
      ).rejects.toThrow(/does not match its log/);
    });

    it("an injected extra leaf, a duplicate log, a log from another contract", async () => {
      await expect(tamper((l) => [...l, { ...leafLogs(l)[0]!, logIndex: 99 }])).rejects.toThrow(SyncIntegrityError);
      await expect(tamper((l) => [...l, l[0]!])).rejects.toThrow(/duplicate/);
      await expect(
        tamper((l) => [...l, { ...l[0]!, address: "0x9999999999999999999999999999999999999999", logIndex: 77 }]),
      ).rejects.toThrow(/not the pool/);
    });

    it("a deposit event whose commitment is not a leaf", async () => {
      await expect(
        tamper((l) => {
          const dep = l.find((x) => x.topics[0] === POOL_EVENTS.Deposited)!;
          dep.data = encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
            [1n, 2n, 3n, 4n],
          );
          return l;
        }),
      ).rejects.toThrow(/not a leaf/);
    });
  });

  it("ASP labels must hash to Entrypoint.latestRoot() exactly", async () => {
    const { pool, labels } = await history();
    const good = [labels.a, labels.b];
    const p = fakeProvider(pool, { aspRoot: () => rootOf(good) });
    expect((await verifiedAspLabels(p, ENTRYPOINT, staticAsp(good))).labels).toEqual(good);
    await expect(verifiedAspLabels(p, ENTRYPOINT, staticAsp([labels.a]))).rejects.toBeInstanceOf(AspIntegrityError);
  });

  it("finds the root index hint", async () => {
    const { pool } = await history();
    expect(await findRootIndex(fakeProvider(pool), POOL, pool.root)).toBe(pool.leaves.length % 64);
    await expect(findRootIndex(fakeProvider(pool), POOL, 42n)).rejects.toThrow(/history/);
  });
});

describe("note discovery", () => {
  it("finds our deposits by precommitment and follows withdrawal lineages", async () => {
    const { pool, signer, labels } = await history();
    const st = await syncPool(fakeProvider(pool), { pool: POOL, fromBlock: 100n });
    const sm = createSignatureSecretManager({
      signer,
      chainId: CHAIN,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    const { notes, nextDepositIndex } = await discoverNotes({
      secrets: sm,
      state: st,
      aspLabels: [labels.a, labels.b],
    });
    expect(nextDepositIndex).toBe(3);
    expect(notes.map((n) => [n.depositIndex, n.secretIndex, n.value, n.status])).toEqual([
      [0, 0, 1n * E, "approved"],
      [1, 2, 1n * E, "approved"],
      [2, 0, 4n * E, "pending"],
    ]);
    expect(spendable(notes).map((n) => n.depositIndex)).toEqual([0, 1]);
    for (const n of notes) expect(st.leaves).toContain(n.commitment);
  });

  it("rejects a Withdrawn event whose change commitment is not derivable from our keys", async () => {
    const signer = softwareSigner();
    const pool = new SimPool();
    const d0 = await secretsFor(signer, 0, 0);
    pool.deposit(1n * E, d0.precommitment);
    pool.withdraw(1n, d0.nullifierHash, 31337n);
    const st = await syncPool(fakeProvider(pool), { pool: POOL, fromBlock: 100n });
    const sm = createSignatureSecretManager({
      signer,
      chainId: CHAIN,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    await expect(discoverNotes({ secrets: sm, state: st, aspLabels: [] })).rejects.toThrow(SyncIntegrityError);
  });
});

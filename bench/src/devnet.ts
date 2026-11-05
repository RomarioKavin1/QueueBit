/**
 * Devnet measurement: for each scheme, deploy the vendored verifier and a BenchAccount, then build, simulate, submit
 * and (where possible) mine two real EIP-8141 frame transactions:
 *
 *   Path A  [VERIFY(self, 0x01): PQ verify + APPROVE] [SENDER(self, 0x03‖to): send 1 wei]     sigs: [ARBITRARY]
 *   Path B  [VERIFY(self, 0x02): payer ECDSA check + APPROVE] [SENDER(self, 0x04‖to): PQ verify, send 1 wei]
 *                                                                               sigs: [ARBITRARY, SECP256K1(payer)]
 *
 * Funds come only from anvil #6 (devnet/README.md "Funding-key allocation"). The local devnet runs the same ethrex
 * build and sidecar image as the public chain-1337 devnet (docs/plan/50-devnet-review.md).
 *
 * Admission is asked of the real endpoints: the sidecar (`eth_sendFrameTransaction`, stock MAX_VERIFY_GAS = 100k)
 * and ethrex's canonical mempool (`eth_sendRawTransaction`). A Path A transaction they reject is then mined through
 * `ethrex_submitPrivilegedFrameTransaction` (the sidecar's relay path, which skips admission; F16) so its receipt can
 * still be read. The BUDGET-010 sidecar (devnet/patched-sidecar, PATCHED_SIDECAR_URL, default :14340) is asked too,
 * after the account stakes itself, which gives a real admission answer for the staked 1M budget.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  encodeTx,
  frame,
  getProfile,
  newTx,
  setSignature,
  sigHash,
  signTx,
  toWire,
  txHash,
  type FrameTx,
  type SignatureEntry,
} from "@leaked/frames";
import { concat, encodeAbiParameters, keccak256, numberToHex, toHex, toRlp, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CACHE_DIR, CONTRACTS_DIR, readJson, writeJson } from "./env.js";
import {
  EIP7623_FLOOR_PER_TOKEN,
  EIP8141,
  calldataFloorGas,
  intrinsicGas,
  predictedGasUsed,
  prefixValidationGas,
  tightLimit,
  type TxShape,
} from "./floor.js";
import { SCHEMES, type SchemeDef } from "./schemes.js";
import { SIGNERS, hex, unhex, type BenchKey } from "./signers.js";
import type { Admission, Maybe, PathResult } from "./schema.js";
import { measured, notMeasured } from "./schema.js";

export const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
export const SIDECAR = process.env.SIDECAR_URL ?? "http://localhost:14337/rpc";
/** BUDGET-010 sidecar (devnet/patched-sidecar, 100k unstaked / 1M staked). Used when it answers skandha_config. */
export const PATCHED_SIDECAR_CANDIDATE = process.env.PATCHED_SIDECAR_URL ?? "http://localhost:14340/rpc";
let PATCHED_SIDECAR: string | undefined;
const STAKING_REGISTRY: Address =
  (process.env.STAKING_REGISTRY as Address) ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC";
const CHAIN_ID = 1337;
/** anvil #6 (public test key; devnet/README.md assigns it to bench/). */
const FUNDER_KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";
const funder = privateKeyToAccount(FUNDER_KEY);
/** Path B payer key: derived from a public label, holds no funds (the account pays). */
const PAYER_KEY = keccak256(toHex("leaked-bench/v1/path-b-payer"));
const payer = privateKeyToAccount(PAYER_KEY);
const P = getProfile("ethrex-eip8141-tracer");
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

// ------------------------------------------------------------------------------------------------------------------

let rpcId = 0;
export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (j.error)
    throw new Error(`${method}: ${j.error.message}${j.error.data ? ` ${JSON.stringify(j.error.data)}` : ""}`);
  return j.result as T;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Receipt {
  status: string;
  gasUsed: Hex;
  blockNumber: Hex;
  contractAddress?: Address;
  frameReceipts?: { status: Hex; gasUsed: Hex; stateGasUsed?: Hex }[];
}

async function waitReceipt(hash: Hex, timeoutMs = 180_000): Promise<Receipt> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rpc<Receipt | null>(ETHREX, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    await sleep(1500);
  }
  throw new Error(`timeout waiting for ${hash}`);
}

async function sendLegacy(to: Address | null, data: Hex, value: bigint, gas: bigint): Promise<Receipt> {
  const nonce = Number(await rpc<Hex>(ETHREX, "eth_getTransactionCount", [funder.address, "pending"]));
  const signed = await funder.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce,
    gasPrice: 2_000_000_000n,
    gas,
    to: to ?? undefined,
    data,
    value,
  });
  const h = await rpc<Hex>(ETHREX, "eth_sendRawTransaction", [signed]);
  const r = await waitReceipt(h);
  if (r.status !== "0x1") throw new Error(`legacy tx ${h} reverted`);
  return r;
}

function artifact(file: string, contract: string): Hex {
  const j = JSON.parse(readFileSync(join(CONTRACTS_DIR, "out", file, `${contract}.json`), "utf8")) as {
    bytecode: { object: Hex };
  };
  return j.bytecode.object;
}

async function deploy(initcode: Hex, value = 0n): Promise<{ address: Address; gasUsed: number }> {
  const r = await sendLegacy(null, initcode, value, 30_000_000n);
  return { address: r.contractAddress!, gasUsed: Number(r.gasUsed) };
}

// ------------------------------------------------------------------------------------------------------------------

const word = (x: bigint | Hex): Hex =>
  typeof x === "bigint" ? numberToHex(x, { size: 32 }) : (x.padEnd(66, "0") as Hex);
const addrWord = (a: Address): Hex => numberToHex(BigInt(a), { size: 32 });

export function accountConfig(s: SchemeDef, verifier: Address, key: BenchKey, payerAddr: Address): Hex {
  const v = s.verifier!;
  const st = key.staticArgs;
  return concat([
    addrWord(verifier),
    word(BigInt(v.selector) << 224n),
    word(BigInt(v.nStatic)),
    st[0] ?? word(0n),
    st[1] ?? word(0n),
    word(v.okWord),
    word(BigInt(v.sigLen)),
    addrWord(payerAddr),
  ]);
}

const rlpInt = (x: bigint): Hex => (x === 0n ? "0x" : numberToHex(x));

/** EIP-8250 nonce calldata `rlp(nonce_keys) ‖ rlp(nonce_seq)` (ethrex 9aa3645d `nonce_calldata`). */
export function nonceCalldata(tx: FrameTx): Uint8Array {
  return unhex(concat([toRlp(tx.nonceKeys.map(rlpInt)), toRlp(rlpInt(tx.nonceSeq))]));
}

export function shapeOf(tx: FrameTx): TxShape {
  const schemeName = (n: number): "ARBITRARY" | "SECP256K1" | "P256" =>
    n === 0 ? "ARBITRARY" : n === 1 ? "SECP256K1" : "P256";
  return {
    nonceCalldata: nonceCalldata(tx),
    frames: tx.frames.map((f) => ({
      data: unhex(f.data),
      valueToOther: f.value > 0n && f.target !== null && f.target.toLowerCase() !== tx.sender.toLowerCase(),
      hasValue: f.value > 0n,
      limits: f.limits,
    })),
    signatures: tx.signatures.map((s) => ({
      scheme: schemeName(s.scheme),
      signerLen: unhex(s.signer).length,
      msgLen: unhex(s.msg).length,
      sigLen: unhex(s.signature).length,
      signerBytes: unhex(s.signer),
      sigBytes: unhex(s.signature),
    })),
  };
}

interface Built {
  tx: FrameTx;
  raw: Hex;
  hash: Hex;
  witnessBytes: number;
  signMs: number;
}

async function buildTx(
  path: "A" | "B",
  account: Address,
  pqLimit: bigint,
  s: SchemeDef,
  sign: (d: Uint8Array) => Promise<{ witness: Uint8Array; ms: number }>,
): Promise<Built> {
  const nonce = BigInt(await rpc<Hex>(ETHREX, "eth_getTransactionCount", [account, "latest"]));
  const body = concat([path === "A" ? "0x03" : "0x04", funder.address]);
  const frames =
    path === "A"
      ? [
          frame(P, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: pqLimit, data: "0x01" }),
          frame(P, "SENDER", { execution: 60_000n, data: body }),
        ]
      : [
          frame(P, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 30_000n, data: "0x02" }),
          frame(P, "SENDER", { execution: pqLimit, data: body }),
        ];
  const placeholder: SignatureEntry = {
    scheme: 0,
    signer: "0x",
    msg: "0x",
    signature: hex(new Uint8Array(s.verifier!.sigLen || 64)),
  };
  const sigs: SignatureEntry[] = [placeholder];
  if (path === "B") sigs.push({ scheme: 1, signer: payer.address, msg: "0x", signature: "0x" });
  let tx = newTx({ chainId: CHAIN_ID, sender: account, nonceSeq: nonce, fees: FEES, frames, signatures: sigs });
  const digest = unhex(sigHash(P, tx));
  const { witness, ms } = await sign(digest);
  tx = setSignature(P, tx, 0, hex(witness));
  if (sigHash(P, tx) !== hex(digest))
    throw new Error("sig hash changed after inserting the witness (profile commits to it?)");
  if (path === "B") tx = await signTx(P, tx, PAYER_KEY, 1);
  return { tx, raw: encodeTx(P, tx), hash: txHash(P, tx), witnessBytes: witness.length, signMs: ms };
}

interface SimResult {
  canonicalMempoolValid?: boolean;
  canonicalMempoolViolation?: string | null;
  prefixShape?: string | null;
  gasUsed?: Hex;
  frames?: { succeeded?: boolean; gasUsed?: Hex | number }[];
  executionStatus?: string;
  executionError?: string | null;
}

async function simulate(raw: Hex): Promise<SimResult | { error: string }> {
  try {
    const r = await rpc<SimResult & { erc7562Trace?: unknown }>(ETHREX, "ethrex_simulateFrameTransaction", [
      raw,
      "latest",
      { trace: true },
    ]);
    const { erc7562Trace: _t, ...rest } = r;
    return rest;
  } catch (e) {
    return { error: errText(e) };
  }
}

/** Submit: sidecar first (stock admission), then ethrex's canonical mempool, then the privileged relay. */
async function submit(b: Built): Promise<{ admission: Admission[]; via: string | null; receipt: Receipt | null }> {
  const admission: Admission[] = [];
  const endpoints: [string, () => Promise<Hex>][] = [
    [
      "sidecar eth_sendFrameTransaction (stock, MAX_VERIFY_GAS 100k)",
      () => rpc<Hex>(SIDECAR, "eth_sendFrameTransaction", [toWire(b.tx)]),
    ],
  ];
  const patched = PATCHED_SIDECAR;
  if (patched) {
    endpoints.push([
      "patched sidecar eth_sendFrameTransaction (BUDGET-010: 100k unstaked / 1M staked; account staked)",
      () => rpc<Hex>(patched, "eth_sendFrameTransaction", [toWire(b.tx)]),
    ]);
  }
  endpoints.push([
    "ethrex eth_sendRawTransaction (canonical mempool)",
    () => rpc<Hex>(ETHREX, "eth_sendRawTransaction", [b.raw]),
  ]);
  for (const [name, call] of endpoints) {
    try {
      const h = await call();
      admission.push({ endpoint: name, accepted: true });
      if (h.toLowerCase() !== b.hash.toLowerCase()) throw new Error(`${name} returned ${h}, codec says ${b.hash}`);
      return { admission, via: name, receipt: await waitReceipt(b.hash) };
    } catch (e) {
      admission.push({ endpoint: name, accepted: false, error: errText(e) });
    }
  }
  // Last resort: the builder hook. It tries a tx in exactly one payload build and silently drops it when it does
  // not apply or misses the build, so retry with an explicit targetBlock a couple of blocks ahead.
  const via = "ethrex_submitPrivilegedFrameTransaction (builder hook, skips admission)";
  let lastErr = "not included";
  for (let i = 0; i < 4; i++) {
    try {
      const head = BigInt(await rpc<Hex>(ETHREX, "eth_blockNumber"));
      await rpc<Hex>(ETHREX, "ethrex_submitPrivilegedFrameTransaction", [b.raw, numberToHex(head + 2n)]);
      const r = await waitReceipt(b.hash, 45_000).catch(() => null);
      if (r) {
        admission.push({ endpoint: via, accepted: true });
        return { admission, via, receipt: r };
      }
    } catch (e) {
      lastErr = errText(e);
    }
  }
  admission.push({ endpoint: via, accepted: false, error: `${lastErr} after 4 attempts` });
  return { admission, via: null, receipt: null };
}

const n = (x: Hex | number | undefined): number => (x === undefined ? 0 : Number(x));

/**
 * Stake the bench account on the NaiveStakingRegistry (0.012 ETH, 1 day delay) from a SENDER frame, so the BUDGET-010
 * sidecar treats it as a staked entity. VERIFY = the cheap payer-ECDSA check (op 0x02); entry 0 is a 1-byte dummy.
 */
async function stake(account: Address): Promise<{ txHash: Hex; deposit: string }> {
  const nonce = BigInt(await rpc<Hex>(ETHREX, "eth_getTransactionCount", [account, "latest"]));
  const addStake = concat(["0x0396cb60", numberToHex(86_400n, { size: 32 })]); // addStake(uint32)
  const data = concat(["0x05", STAKING_REGISTRY, numberToHex(12n * 10n ** 15n, { size: 32 }), addStake]);
  let tx = newTx({
    chainId: CHAIN_ID,
    sender: account,
    nonceSeq: nonce,
    fees: FEES,
    frames: [
      frame(P, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 30_000n, data: "0x02" }),
      frame(P, "SENDER", { execution: 200_000n, state: 300_000n, data }),
    ],
    signatures: [
      { scheme: 0, signer: "0x", msg: "0x", signature: "0x00" },
      { scheme: 1, signer: payer.address, msg: "0x", signature: "0x" },
    ],
  });
  tx = await signTx(P, tx, PAYER_KEY, 1);
  const h = await rpc<Hex>(ETHREX, "eth_sendRawTransaction", [encodeTx(P, tx)]);
  const r = await waitReceipt(h);
  if (r.frameReceipts?.[1]?.status !== "0x1") throw new Error(`staking tx ${h} failed`);
  const info = await rpc<Hex>(ETHREX, "eth_call", [
    { to: STAKING_REGISTRY, data: concat(["0x5287ce12", numberToHex(BigInt(account), { size: 32 })]) },
    "latest",
  ]);
  return { txHash: h, deposit: info };
}

export interface DevnetSchemeOut {
  id: string;
  verifier: Address;
  account: Address;
  deployGas: { verifier: number; account: number };
  stakeTx: Hex | null;
  pathA: Maybe<PathResult>;
  pathB: Maybe<PathResult>;
  signMs: number[];
  log: string[];
}

async function measurePath(
  path: "A" | "B",
  s: SchemeDef,
  account: Address,
  forgeGas: number | undefined,
  sign: (d: Uint8Array) => Promise<{ witness: Uint8Array; ms: number }>,
  signMs: number[],
  log: (m: string) => void,
): Promise<Maybe<PathResult>> {
  // First limit: the Forge measurement plus frame glue, with the 63/64 reserve; doubled on each out-of-gas retry.
  let limit = tightLimit(BigInt(forgeGas ?? 200_000) + 25_000n);
  for (let attempt = 0; attempt < 4; attempt++, limit *= 2n) {
    const b = await buildTx(path, account, limit, s, sign);
    signMs.push(b.signMs);
    const sim = await simulate(b.raw);
    log(
      `${s.id} path ${path}: limit ${limit}, witness ${b.witnessBytes} B, simulate ${JSON.stringify(sim).slice(0, 300)}`,
    );
    const pqIdx = path === "A" ? 0 : 1;
    const simOk = "canonicalMempoolValid" in sim;
    const simFrames = simOk ? ((sim as SimResult).frames ?? []) : [];
    const simPqOk = simFrames[pqIdx] ? simFrames[pqIdx]!.succeeded !== false : false;
    if (simOk && !simPqOk && attempt < 3) {
      log(`${s.id} path ${path}: PQ frame failed in simulate at limit ${limit}; retrying higher`);
      continue;
    }
    const sub = await submit(b);
    const rcpt = sub.receipt;
    const fr = rcpt?.frameReceipts ?? [];
    if (rcpt && fr[pqIdx]?.status !== "0x1" && attempt < 3) {
      log(`${s.id} path ${path}: PQ frame status ${fr[pqIdx]?.status} at limit ${limit}; retrying higher`);
      continue;
    }
    if (!rcpt && !simOk) {
      return notMeasured(
        `not mined and simulate failed: ${(sim as { error: string }).error}; ${sub.admission.map((a) => `${a.endpoint}: ${a.error ?? "ok"}`).join(" | ")}`,
      );
    }
    // Per-frame gas: the receipt when mined, else the simulation (which executes the frames even when the prefix is
    // over MAX_VERIFY_GAS).
    const frameGasUsed = rcpt ? fr.map((f) => n(f.gasUsed)) : simFrames.map((f) => n(f.gasUsed));
    const frameState = rcpt ? fr.map((f) => n(f.stateGasUsed)) : simFrames.map(() => 0);
    const shape = shapeOf(b.tx);
    const usedPerFrame = frameGasUsed.map((g, i) => ({ execution: BigInt(g), state: BigInt(frameState[i] ?? 0) }));
    const pred = predictedGasUsed(shape, usedPerFrame);
    const predDev = predictedGasUsed(shape, usedPerFrame, EIP8141.TOTAL_COST_FLOOR_PER_TOKEN, "ethrex-1337");
    const txGasUsed = rcpt ? n(rcpt.gasUsed) : null;
    const reasonNotMined = `not included: ${sub.admission.map((a) => `${a.endpoint}: ${a.accepted ? "accepted" : a.error}`).join(" | ")}`;
    const res: PathResult = {
      limits: b.tx.frames.map((f) => Number(f.limits.execution)),
      frameGasUsed,
      pqFrameGas: frameGasUsed[pqIdx] ?? 0,
      verifyFrameGas: frameGasUsed[0] ?? 0,
      prefixValidationGas: Number(prefixValidationGas(shape, 1)),
      intrinsicGas: intrinsicGas(shape),
      calldataFloor8141: calldataFloorGas(shape),
      calldataFloor7623: calldataFloorGas(shape, EIP7623_FLOOR_PER_TOKEN),
      predictedGasUsed: Number(pred.gasUsed),
      intrinsicGasDevnet: intrinsicGas(shape, "ethrex-1337"),
      calldataFloorDevnet: calldataFloorGas(shape, EIP8141.TOTAL_COST_FLOOR_PER_TOKEN, "ethrex-1337"),
      predictedGasUsedDevnet: Number(predDev.gasUsed),
      receiptMatchesDevnetFormula: txGasUsed === null ? null : BigInt(txGasUsed) === predDev.gasUsed,
      floorBound: predDev.floorBound,
      simulatedGasUsed: simOk ? n((sim as SimResult).gasUsed) : 0,
      txGasUsed:
        txGasUsed === null
          ? notMeasured(reasonNotMined)
          : measured(txGasUsed, "receipt gasUsed (ethrex eth_getTransactionReceipt)"),
      receiptMatchesFormula: txGasUsed === null ? null : BigInt(txGasUsed) === pred.gasUsed,
      simulate: simOk
        ? {
            canonicalMempoolValid: Boolean((sim as SimResult).canonicalMempoolValid),
            violation: (sim as SimResult).canonicalMempoolViolation ?? null,
            prefixShape: (sim as SimResult).prefixShape ?? null,
          }
        : { canonicalMempoolValid: false, violation: (sim as { error: string }).error, prefixShape: null },
      admission: sub.admission,
      inclusion: rcpt
        ? { via: sub.via!, txHash: b.hash, blockNumber: n(rcpt.blockNumber), status: rcpt.status }
        : notMeasured(reasonNotMined),
      witnessBytes: b.witnessBytes,
    };
    if (rcpt && fr[pqIdx]?.status !== "0x1") {
      return notMeasured(`PQ frame failed (status ${fr[pqIdx]?.status}) at every limit up to ${limit}; tx ${b.hash}`);
    }
    if (!rcpt && !simPqOk) return notMeasured(`PQ frame failed in simulation at every limit up to ${limit}`);
    return measured(
      res,
      rcpt
        ? "local devnet frame tx: ethrex_simulateFrameTransaction {trace:true} + mined receipt frameReceipts"
        : "local devnet frame tx: ethrex_simulateFrameTransaction {trace:true} per-frame gasUsed (tx not included; see txGasUsed)",
    );
  }
  return notMeasured("retries exhausted");
}

export async function runDevnet(only: string[] | undefined, log: (m: string) => void): Promise<void> {
  const chainId = await rpc<Hex>(ETHREX, "eth_chainId");
  if (Number(chainId) !== CHAIN_ID) throw new Error(`expected chain 1337 at ${ETHREX}, got ${chainId}`);
  const forge = readJson<{ gas: Record<string, number[]> }>(join(CACHE_DIR, "forge.json"));
  const env = {
    rpc: ETHREX,
    sidecar: SIDECAR,
    clientVersion: await rpc<string>(ETHREX, "web3_clientVersion"),
    sidecarVersion: await rpc<string>(SIDECAR, "web3_clientVersion").catch((e) => `unavailable: ${errText(e)}`),
    chainId: CHAIN_ID,
    blockAtStart: Number(await rpc<Hex>(ETHREX, "eth_blockNumber")),
    funder: funder.address,
    payer: payer.address,
    measuredAt: new Date().toISOString(),
  };
  try {
    const cfg = await rpc<{ budgets?: Record<string, unknown> }>(PATCHED_SIDECAR_CANDIDATE, "skandha_config");
    if (cfg.budgets) PATCHED_SIDECAR = PATCHED_SIDECAR_CANDIDATE;
    Object.assign(env, {
      patchedSidecar: PATCHED_SIDECAR ?? null,
      patchedSidecarBudgets: JSON.stringify(cfg.budgets ?? null),
    });
  } catch (e) {
    Object.assign(env, { patchedSidecar: null, patchedSidecarError: errText(e) });
  }
  writeJson(join(CACHE_DIR, "devnet", "_env.json"), env);
  log(`devnet ${env.clientVersion}, sidecar ${env.sidecarVersion}, funder ${funder.address}`);

  const accountCode = artifact("BenchAccount.yul", "BenchAccount");
  for (const s of SCHEMES) {
    if (!s.verifier || s.notMeasured) continue;
    if (only && !only.includes(s.id)) continue;
    const lines: string[] = [];
    const l = (m: string) => {
      lines.push(m);
      log(m);
    };
    const signer = SIGNERS[s.id]!();
    const key = await signer.keygen();
    const ctor = key.ctorArgs ? encodeAbiParameters([{ type: "bytes32" }], [key.ctorArgs]) : "0x";
    const v = await deploy(concat([artifact(s.verifier.file, s.verifier.contract), ctor]));
    const acct = await deploy(concat([accountCode, accountConfig(s, v.address, key, payer.address)]), 10n ** 18n / 2n);
    l(`${s.id}: verifier ${v.address} (${v.gasUsed} gas), account ${acct.address} (${acct.gasUsed} gas)`);
    const staked = PATCHED_SIDECAR ? await stake(acct.address) : null;
    if (staked) l(`${s.id}: account staked, tx ${staked.txHash}, getDepositInfo ${staked.deposit.slice(0, 66)}`);
    const fg = forge?.gas[s.id];
    const fgMax = fg ? Math.max(...fg) : undefined;
    const signMs: number[] = [];
    const pathA = await measurePath("A", s, acct.address, fgMax, signer.sign, signMs, l);
    const pathB = await measurePath("B", s, acct.address, fgMax, signer.sign, signMs, l);
    const out: DevnetSchemeOut = {
      id: s.id,
      verifier: v.address,
      account: acct.address,
      deployGas: { verifier: v.gasUsed, account: acct.gasUsed },
      stakeTx: staked?.txHash ?? null,
      pathA,
      pathB,
      signMs,
      log: lines,
    };
    writeJson(join(CACHE_DIR, "devnet", `${s.id}.json`), out);
  }
}

export { EIP8141 };

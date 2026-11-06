/**
 * One signer per benchmarked scheme, behind a common interface: `keygen()` once (cached under .cache/keys; these are
 * throwaway bench keys derived from public labels, never real keys) and `sign(digest)` per transaction.
 *
 * Sources: C13 = this repo's @queuebit/pq-signer (bit-identical to upstream); C7 = upstream Python reference
 * `script/signer.py`; leanSphincs-s = upstream Rust `lssk` (Light tier key file); SLH-DSA-SHA2-128-24 = upstream C
 * fork of the sphincsplus reference; SLH-DSA-SHA2-128s = @noble/post-quantum 0.7.1; PORST = ./porst.ts;
 * ETHFALCON = upstream Python `pythonref/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";
import { keygen as c13Keygen, sign as c13Sign } from "@queuebit/pq-signer";
import { KEYS_DIR, readJson, run, toolEnv, writeJson } from "./env.js";
import { PORST_R16, PORST_R256, porstKeygen, porstSign, type PorstKey, type PorstParams } from "./porst.js";

export type Hex = `0x${string}`;

export const hex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
export const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const label = (s: string): Uint8Array => keccak_256(new TextEncoder().encode(`queuebit-bench/v1/${s}`));
/** A 16-byte value as a top-aligned 32-byte word (the SPHINCS- verifiers' key encoding). */
const top16 = (b: Uint8Array): Hex => hex(Uint8Array.from([...b.subarray(0, 16), ...new Uint8Array(16)]));

export interface BenchKey {
  /** Static verifier arguments placed before the digest (account config words 3-4). */
  staticArgs: Hex[];
  /** Constructor arguments for verifiers that bind the key at deployment (PORST), ABI-encoded. */
  ctorArgs?: Hex;
  /** Public key bytes as the scheme defines them. */
  publicKey: Hex;
  /** Wall-clock keygen time when it was generated (ms), for the notes. */
  keygenMs: number;
}

export interface Signer {
  keygen(): Promise<BenchKey>;
  /** Returns the ARBITRARY witness and the wall-clock signing time. */
  sign(digest: Uint8Array): Promise<{ witness: Uint8Array; ms: number }>;
}

function cached<T>(name: string, make: () => Promise<T>): () => Promise<T> {
  let mem: T | undefined;
  return async () => {
    if (mem) return mem;
    const p = join(KEYS_DIR, `${name}.json`);
    const have = readJson<T>(p);
    if (have) return (mem = have);
    mem = await make();
    writeJson(p, mem);
    return mem;
  };
}

/** ABI-decode `(bytes32, bytes32, bytes)` as printed by the upstream CLIs. */
function decodeSeedRootSig(out: string): { w0: Hex; w1: Hex; sig: Uint8Array } {
  const b = unhex(out.trim());
  const w0 = hex(b.subarray(0, 32));
  const w1 = hex(b.subarray(32, 64));
  const len = Number(BigInt(hex(b.subarray(96, 128))));
  return { w0, w1, sig: b.slice(128, 128 + len) };
}

// ---------------------------------------------------------------------------------------------------------------

export function c13Signer(): Signer {
  const seed = Uint8Array.from([...label("c13/seed-a"), ...label("c13/seed-b")]);
  const kp = () => c13Keygen(seed, { role: "vault" });
  const key = cached<BenchKey>("c13", async () => {
    const t0 = performance.now();
    const { publicKey, secretKey } = kp();
    secretKey.fill(0);
    return {
      staticArgs: [top16(publicKey.subarray(0, 16)), top16(publicKey.subarray(16, 32))],
      publicKey: hex(publicKey),
      keygenMs: performance.now() - t0,
    };
  });
  return {
    keygen: key,
    async sign(digest) {
      const { secretKey } = kp();
      const t0 = performance.now();
      const witness = c13Sign(secretKey, digest);
      const ms = performance.now() - t0;
      secretKey.fill(0);
      return { witness, ms };
    },
  };
}

/** SPHINCS- Python reference (`script/signer.py <variant>`), used for C7. */
export function sphincsPySigner(variant: string): Signer {
  const seed = hex(label(`${variant}/pk-seed`).map((x, i) => (i < 16 ? x : 0)));
  const skSeed = hex(label(`${variant}/sk-seed`));
  const py = async (msg: Hex, root?: Hex) => {
    const env = toolEnv();
    const args = [
      join(import.meta.dirname, "..", "signers", "sphincs_py_sign.py"),
      env.sphincsMinusDir,
      variant,
      seed,
      skSeed,
      msg,
    ];
    if (root) args.push(root);
    const { stdout } = await run(env.python, args, { timeoutMs: 60 * 60_000 });
    return JSON.parse(stdout.trim().split("\n").pop()!) as { seed: Hex; root: Hex; sig: Hex; ms: number };
  };
  const key = cached<BenchKey>(variant, async () => {
    const t0 = performance.now();
    const r = await py(hex(new Uint8Array(32)));
    return {
      staticArgs: [r.seed, r.root],
      publicKey: hex(Uint8Array.from([...unhex(r.seed).subarray(0, 16), ...unhex(r.root).subarray(0, 16)])),
      keygenMs: performance.now() - t0,
    };
  });
  return {
    keygen: key,
    async sign(digest) {
      const k = await key();
      const r = await py(hex(digest), k.staticArgs[1]);
      if (r.seed !== k.staticArgs[0] || r.root !== k.staticArgs[1]) throw new Error(`${variant}: key mismatch`);
      return { witness: unhex(r.sig), ms: r.ms };
    },
  };
}

/** leanSphincs-s: upstream `lssk` with a Light-tier key file (2^13 kept subtree, 16 KiB cache). */
export function leanSphincsSigner(): Signer {
  const keyFile = join(KEYS_DIR, "leansphincs-s.lssk");
  const key = cached<BenchKey>("leansphincs-s", async () => {
    mkdirSync(KEYS_DIR, { recursive: true });
    const seedFile = join(KEYS_DIR, "leansphincs-s.seed");
    writeFileSync(seedFile, Buffer.from(label("leansphincs-s/seed")).toString("hex"), { mode: 0o600 });
    const { stdout, ms } = await run(toolEnv().lssk, [
      "keygen",
      "--seed-file",
      seedFile,
      "--tier",
      "light",
      "-o",
      keyFile,
      "--force",
    ]);
    const b = unhex(stdout.trim());
    return {
      staticArgs: [hex(b.subarray(0, 32)), hex(b.subarray(32, 64))],
      publicKey: hex(Uint8Array.from([...b.subarray(0, 16), ...b.subarray(32, 48)])),
      keygenMs: ms,
    };
  });
  return {
    keygen: key,
    async sign(digest) {
      const k = await key();
      const { stdout, ms } = await run(toolEnv().lssk, ["sign-key", keyFile, hex(digest).slice(2)]);
      const r = decodeSeedRootSig(stdout);
      if (r.w0 !== k.staticArgs[0] || r.w1 !== k.staticArgs[1]) throw new Error("lssk: key mismatch");
      return { witness: r.sig, ms };
    },
  };
}

/**
 * SLH-DSA-SHA2-128-24 via the upstream C fork. The CLI regenerates the 2^22-leaf XMSS tree on every call, so the
 * reported signing time includes keygen (that is the "zero-memory" signer the upstream README describes).
 * It signs raw bytes (slh_sign_internal), so we apply the FIPS 205 external envelope M' = 0x00 0x00 ‖ M here.
 */
export function slhDsa24Signer(): Signer {
  const seed48 = hex(Uint8Array.from([...label("slh24/a"), ...label("slh24/b")].slice(0, 48)));
  const call = async (msg: Uint8Array) => {
    const { stdout, ms } = await run(toolEnv().slhdsa24, [seed48, hex(Uint8Array.from([0, 0, ...msg])).slice(2)], {
      timeoutMs: 60 * 60_000,
    });
    const b = unhex(stdout.trim());
    return { pkSeed: b.subarray(0, 16), pkRoot: b.subarray(16, 32), sig: b.slice(32), ms };
  };
  const key = cached<BenchKey>("slh-dsa-sha2-128-24", async () => {
    const r = await call(new Uint8Array(32));
    return {
      staticArgs: [top16(r.pkSeed), top16(r.pkRoot)],
      publicKey: hex(Uint8Array.from([...r.pkSeed, ...r.pkRoot])),
      keygenMs: r.ms,
    };
  });
  return {
    keygen: key,
    async sign(digest) {
      const k = await key();
      const r = await call(digest);
      if (top16(r.pkRoot) !== k.staticArgs[1]) throw new Error("slh-dsa-24: key mismatch");
      return { witness: r.sig, ms: r.ms };
    },
  };
}

/** SLH-DSA-SHA2-128s via @noble/post-quantum (FIPS 205 external sign, empty context). */
export function slhDsa128sSigner(): Signer {
  const seed = Uint8Array.from([...label("slh128s/a"), ...label("slh128s/b")].slice(0, 48));
  const kp = () => slh_dsa_sha2_128s.keygen(seed);
  const key = cached<BenchKey>("slh-dsa-sha2-128s", async () => {
    const t0 = performance.now();
    const { publicKey } = kp();
    return {
      staticArgs: [top16(publicKey.subarray(0, 16)), top16(publicKey.subarray(16, 32))],
      publicKey: hex(publicKey),
      keygenMs: performance.now() - t0,
    };
  });
  return {
    keygen: key,
    async sign(digest) {
      const { secretKey } = kp();
      const t0 = performance.now();
      const witness = slh_dsa_sha2_128s.sign(digest, secretKey);
      const ms = performance.now() - t0;
      secretKey.fill(0);
      return { witness, ms };
    },
  };
}

export function porstSigner(id: string, params: PorstParams): Signer {
  const seed = label(`${id}/seed`);
  const bin = join(KEYS_DIR, `${id}.upper.bin`);
  let mem: PorstKey | undefined;
  const load = (): PorstKey => {
    if (mem) return mem;
    const meta = readJson<{ cutLevel: number }>(join(KEYS_DIR, `${id}.json`));
    if (meta && existsSync(bin)) {
      const raw = new Uint8Array(readFileSync(bin));
      const upper: Uint8Array[] = [];
      let o = 0;
      for (let l = meta.cutLevel; l <= params.treeHeight; l++) {
        const len = 32 << (params.treeHeight - l);
        upper.push(raw.subarray(o, o + len));
        o += len;
      }
      return (mem = { params, seed, cutLevel: meta.cutLevel, upper, root: upper[upper.length - 1]! });
    }
    mem = porstKeygen(params, seed);
    mkdirSync(KEYS_DIR, { recursive: true });
    writeFileSync(bin, Buffer.concat(mem.upper));
    return mem;
  };
  const key = cached<BenchKey & { cutLevel: number }>(id, async () => {
    const t0 = performance.now();
    const k = load();
    return {
      staticArgs: [],
      ctorArgs: hex(k.root),
      publicKey: hex(k.root),
      keygenMs: performance.now() - t0,
      cutLevel: k.cutLevel,
    };
  });
  return {
    keygen: key,
    async sign(digest) {
      await key();
      const k = load();
      const salt = keccak_256(Uint8Array.from([...digest, ...crypto.getRandomValues(new Uint8Array(32))]));
      const t0 = performance.now();
      const witness = porstSign(k, digest, salt);
      return { witness, ms: performance.now() - t0 };
    },
  };
}

export function ethfalconSigner(): Signer {
  const keyFile = join(KEYS_DIR, "ethfalcon.sk");
  const script = () => join(import.meta.dirname, "..", "signers", "ethfalcon_sign.py");
  const key = cached<BenchKey>("ethfalcon", async () => {
    mkdirSync(KEYS_DIR, { recursive: true });
    const { stdout, ms } = await run(toolEnv().python, [script(), toolEnv().ethfalconDir, "keygen", keyFile]);
    const { ntth } = JSON.parse(stdout.trim().split("\n").pop()!) as { ntth: Hex };
    return { staticArgs: [hex(keccak_256(unhex(ntth)))], publicKey: ntth, keygenMs: ms };
  });
  return {
    keygen: key,
    async sign(digest) {
      await key();
      const { stdout } = await run(toolEnv().python, [script(), toolEnv().ethfalconDir, "sign", keyFile, hex(digest)]);
      const r = JSON.parse(stdout.trim().split("\n").pop()!) as { witness: Hex; ms: number };
      return { witness: unhex(r.witness), ms: r.ms };
    },
  };
}

export const SIGNERS: Record<string, () => Signer> = {
  "sphincs-c13": c13Signer,
  "sphincs-c7": () => sphincsPySigner("c7"),
  "leansphincs-s": leanSphincsSigner,
  "slh-dsa-sha2-128-24": slhDsa24Signer,
  "slh-dsa-sha2-128s": slhDsa128sSigner,
  "porst-r16": () => porstSigner("porst-r16", PORST_R16),
  "porst-r256": () => porstSigner("porst-r256", PORST_R256),
  ethfalcon: ethfalconSigner,
};

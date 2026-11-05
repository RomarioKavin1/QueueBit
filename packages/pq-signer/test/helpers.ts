import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const hexToBytes = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

export const bytesToHex = (b: Uint8Array): string =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const readJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as T;

export interface UpstreamVector {
  name: string;
  seedMaterial: string;
  skSeed?: string;
  msg: string;
  pkSeed: string;
  pkRoot: string;
  sig: string;
}

export interface CVector {
  id: number;
  role: "vault" | "recovery";
  master: string;
  chainScope: string;
  skSeed: string;
  pk: string;
  pkSeed: string;
  pkRoot: string;
  digest: string;
  entropy: string;
  sig: string;
}

/** Upstream test-key derivation (`signer_c13.rs:23-29`), needs keccak: done via the vectors' skSeed when present. */
export const upstream = readJson<{ vectors: UpstreamVector[] }>("../rust/tests/fixtures/upstream_c13.json");
export const katC = readJson<{ schemeId: string; sigLength: number; vectors: CVector[] }>("../vectors/c13.json");

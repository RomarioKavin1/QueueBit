import type {
  CommitmentCircuitInputs,
  ProveResult,
  RagequitProveResult,
  WithdrawCircuitInputs,
} from "@queuebit/privacy";

/**
 * Service worker ⇄ offscreen document (plan §30 §2.1, §2.3): `chrome.runtime.sendMessage` with a `target`
 * discriminator. The extension has ONE offscreen document (`offscreen.html`, Chrome allows one per extension); it
 * hosts the Groth16 withdraw prover in a Worker (`@queuebit/groth16`, MIT) and is the place the Anon-RPC harness
 * would mount (`mountOffscreenHost()`); today it answers `anon:status` with why the private connection is off.
 *
 * Runtime messages are JSON-serialised, so bigints travel tagged (`{"$n": "123"}`): `encodeWire` / `decodeWire`.
 */
export const OFFSCREEN_TARGET = "queuebit-offscreen";
export const OFFSCREEN_PATH = "offscreen.html";

/** Why the private connection (Anon-RPC) is not used, in plain words (ux-spec §3.13). */
export interface AnonStatus {
  available: boolean;
  /** Shown in Settings when `available` is false. */
  reason: string;
}

export interface OffscreenApi {
  /** Liveness and what is loaded (the prover loads its 17 MB key on first use only). */
  ping: { req: Record<string, never>; res: { prover: "idle" | "ready"; provedCount: number } };
  /** One withdraw proof (Groth16, self-verified against the pinned vkey before it is returned). */
  prove: { req: { inputs: WithdrawCircuitInputs }; res: ProveResult };
  /** One public-exit (ragequit) proof over the pinned commitment circuit, self-verified the same way. */
  "prove-ragequit": { req: { inputs: CommitmentCircuitInputs }; res: RagequitProveResult };
  "anon:status": { req: { chainId: number }; res: AnonStatus };
}
export type OffscreenKind = keyof OffscreenApi;

export interface OffscreenRequest<K extends OffscreenKind = OffscreenKind> {
  target: typeof OFFSCREEN_TARGET;
  id: string;
  kind: K;
  /** `encodeWire(OffscreenApi[K]["req"])`. */
  payload: unknown;
}

export type OffscreenResponse<K extends OffscreenKind = OffscreenKind> =
  { ok: true; kind: K; result: unknown } | { ok: false; kind: K; error: { name: string; message: string } };

const KINDS: readonly OffscreenKind[] = ["ping", "prove", "prove-ragequit", "anon:status"];

export function isOffscreenRequest(m: unknown): m is OffscreenRequest {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Partial<OffscreenRequest>;
  return (
    r.target === OFFSCREEN_TARGET &&
    typeof r.id === "string" &&
    typeof r.kind === "string" &&
    (KINDS as readonly string[]).includes(r.kind)
  );
}

export function isOffscreenResponse(m: unknown, kind: OffscreenKind): m is OffscreenResponse {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Partial<OffscreenResponse>;
  return typeof r.ok === "boolean" && r.kind === kind;
}

/** JSON-safe copy: bigint → `{"$n": "<decimal>"}`, recursively (arrays, plain objects). */
export function encodeWire(v: unknown): unknown {
  if (typeof v === "bigint") return { $n: v.toString() };
  if (Array.isArray(v)) return v.map(encodeWire);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encodeWire(x);
    return out;
  }
  return v;
}

/** Inverse of `encodeWire`. A `{"$n"}` that is not a decimal integer is refused. */
export function decodeWire<T>(v: unknown): T {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === "$n") {
        if (typeof o.$n !== "string" || !/^-?\d+$/u.test(o.$n)) throw new TypeError("bad bigint on the wire");
        return BigInt(o.$n);
      }
      return Object.fromEntries(keys.map((k) => [k, walk(o[k])]));
    }
    return x;
  };
  return walk(v) as T;
}

export function offscreenRequest<K extends OffscreenKind>(
  kind: K,
  payload: OffscreenApi[K]["req"],
  id: string,
): OffscreenRequest<K> {
  return { target: OFFSCREEN_TARGET, id, kind, payload: encodeWire(payload) };
}

/** The offscreen document's dispatcher, pure enough to unit-test with fake handlers. */
export async function answerOffscreen(
  req: OffscreenRequest,
  handlers: { [K in OffscreenKind]: (p: OffscreenApi[K]["req"]) => Promise<OffscreenApi[K]["res"]> },
): Promise<OffscreenResponse> {
  try {
    const h = handlers[req.kind] as (p: unknown) => Promise<unknown>;
    return { ok: true, kind: req.kind, result: encodeWire(await h(decodeWire(req.payload))) };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return { ok: false, kind: req.kind, error: { name: err.name, message: err.message } };
  }
}

/** Decodes a response for `kind`, re-throwing the offscreen error with its name (e.g. `ProofSelfCheckError`). */
export function unwrapOffscreen<K extends OffscreenKind>(kind: K, res: unknown): OffscreenApi[K]["res"] {
  if (!isOffscreenResponse(res, kind)) throw new Error("The offscreen document did not answer.");
  if (!res.ok) {
    const e = new Error(res.error.message);
    e.name = res.error.name;
    throw e;
  }
  return decodeWire<OffscreenApi[K]["res"]>(res.result);
}

/** The devnet has no Anon-RPC worker, and this build does not bundle the harness (IMPLEMENTATION-NOTES, M6). */
export function anonStatusFor(chainId: number, opts: { harnessBundled: boolean }): AnonStatus {
  if (chainId === 1337)
    return {
      available: false,
      reason:
        "No private connection is available on this network: Anon-RPC workers are listed on Ethereum mainnet and Sepolia only, so requests to the devnet go direct.",
    };
  if (!opts.harnessBundled)
    return {
      available: false,
      reason:
        "This preview build does not include the private connection yet, so requests go direct to the network provider.",
    };
  return { available: true, reason: "" };
}

import type { PQScheme } from "@leaked/pq-signer";
import type { Review } from "../core/clearsign.js";
import type { VaultRecord } from "../core/db.js";
import { chainScopeFor, keyNumberOf } from "../core/keys.js";
import { countsSignatures, schemeOf, usageStatus, type UsageView } from "../core/usage.js";
import type { WorkerRequest, WorkerResult } from "../worker/protocol.js";

/**
 * The Vault key as the screens see it: its type, number, and (for counted key types) where its signature counter
 * stands. Pure functions over `VaultRecord`, shared by Home, Key health, the approve sheet and the rotation flow.
 */

export interface KeyState {
  scheme: PQScheme;
  /** leanSphincs-s: a counter is kept and enforced. */
  counted: boolean;
  keyNumber: number;
  /** Counted only: the current key's budget (from the plaintext hint; the worker enforces the sealed count). */
  status?: UsageView;
  next?: { keyNumber: number; status?: UsageView };
}

export function keyState(v: VaultRecord): KeyState {
  const scheme = schemeOf(v.schemeId);
  const counted = countsSignatures(v.schemeId);
  const out: KeyState = { scheme, counted, keyNumber: keyNumberOf(v.chainScope) };
  if (counted) out.status = usageStatus(scheme, v.usage ? v.usage.hint : null);
  if (v.next)
    out.next = {
      keyNumber: keyNumberOf(v.next.chainScope),
      ...(counted ? { status: usageStatus(scheme, v.next.usage ? v.next.usage.hint : null) } : {}),
    };
  return out;
}

/** What the approve sheet must do before it may ask for the passphrase. */
export type Gate = { ok: true } | { ok: false; reason: "exceeded" | "unknown" | "rotate"; title: string; body: string };

export function signGate(v: VaultRecord, review: Review): Gate {
  const k = keyState(v);
  if (!k.counted || review.kind === "typedData") return { ok: true };
  const st = review.signingKey === "next" ? k.next?.status : k.status;
  if (!st) return { ok: true };
  if (st.level === "exceeded")
    return st.unknown
      ? {
          ok: false,
          reason: "unknown",
          title: "Replace this key before approving",
          body: "This key was restored from words, so this phone can't know how often it signed on another phone. Make a fresh key and switch the browser to it.",
        }
      : {
          ok: false,
          reason: "exceeded",
          title: "This Vault key is near its safe limit",
          body: "Replace the Vault key before using it again. Code E-73.",
        };
  if (st.level === "rotate" && review.signingKey !== "next" && !v.next)
    return {
      ok: false,
      reason: "rotate",
      title: "Prepare a replacement key first",
      body: "This key has used 90% of its safe signatures. Make its replacement now; then you can keep approving until the browser switches over.",
    };
  return { ok: true };
}

/** The key-related part of the worker's `sign` request. */
export function signKeyParams(
  v: VaultRecord,
  review: Review,
): Pick<
  Extract<WorkerRequest, { op: "sign" }>,
  "schemeId" | "chainScope" | "keyPk" | "usage" | "rotationReady" | "wantLogKey" | "vaultPk"
> {
  const next = review.signingKey === "next" ? v.next : undefined;
  const usage = next ? next.usage : v.usage;
  return {
    vaultPk: v.sealedFor ?? v.vaultPk,
    schemeId: v.schemeId,
    chainScope: next ? next.chainScope : (v.chainScope ?? "any"),
    keyPk: next ? next.pk : v.vaultPk,
    ...(usage ? { usage } : {}),
    rotationReady: !!v.next,
    wantLogKey: !v.logKey,
  };
}

/**
 * The record after a signature: the new count, a new log key, and if the browser has switched to the replacement key
 * (the request named it), the replacement becomes the current key and the old one is retired.
 */
export function afterSign(
  v: VaultRecord,
  review: Review,
  r: Extract<WorkerResult, { op: "sign" }>,
  now: number,
): { vault: VaultRecord; promoted: boolean } {
  let out: VaultRecord = { ...v, lastSignedAt: now };
  if (r.signMs > 0) out.signMs = Math.round(v.signMs ? (v.signMs + r.signMs) / 2 : r.signMs);
  if (r.logKey) out.logKey = r.logKey;
  if (review.kind !== "frameTx") return { vault: out, promoted: false };
  if (review.signingKey === "next" && v.next) {
    const { next, usage: _old, ...rest } = out;
    out = {
      ...rest,
      sealedFor: v.sealedFor ?? v.vaultPk,
      vaultPk: next!.pk,
      chainScope: next!.chainScope,
      ...(r.usage ? { usage: r.usage } : next!.usage ? { usage: next!.usage } : {}),
      retired: [
        ...(v.retired ?? []),
        {
          pk: v.vaultPk,
          chainScope: v.chainScope ?? "any",
          used: v.usage ? v.usage.hint : null,
          retiredAt: now,
        },
      ],
    };
    return { vault: out, promoted: true };
  }
  if (r.usage) out.usage = r.usage;
  return { vault: out, promoted: false };
}

export const nextChainScope = (v: VaultRecord): string => chainScopeFor(keyNumberOf(v.chainScope) + 1);

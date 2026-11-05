import { signWebhook, type Severity } from "@leaked/watcher-core";
import type { HubEntry, Sink } from "./hub.js";

const RANK: Record<Severity, number> = { info: 0, warning: 1, urgent: 2 };
export const atLeast = (s: Severity, min: Severity) => RANK[s] >= RANK[min];

type Fetch = typeof fetch;
type Log = (msg: string, extra?: Record<string, unknown>) => void;

async function withRetry(fn: () => Promise<Response>, tries: number, log: Log, what: string): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn();
      if (r.ok) return true;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        log(`${what} rejected`, { status: r.status });
        return false;
      }
    } catch (e) {
      log(`${what} failed`, { error: (e as Error).message, attempt: i + 1 });
    }
    await new Promise((res) => setTimeout(res, 250 * 2 ** i));
  }
  return false;
}

/**
 * HMAC-signed webhook: `POST url` with body `{"type":"alert"|"retract","seq":n,"alert":{...}}` and
 * `x-leaked-signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` (verify with
 * `verifyWebhook` from @leaked/watcher-core).
 */
export function webhookSink(
  cfg: { url: string; secret: string; minSeverity: Severity },
  opts: { fetch?: Fetch; log?: Log; tries?: number } = {},
): Sink {
  const f = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  return async (e: HubEntry) => {
    if (!atLeast(e.alert.severity, cfg.minSeverity)) return;
    const body = JSON.stringify({ type: e.type, seq: e.seq, alert: e.alert });
    const sig = await signWebhook(cfg.secret, body);
    await withRetry(
      () =>
        f(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-leaked-signature": sig, "x-leaked-event": e.type },
          body,
          signal: AbortSignal.timeout(10_000),
        }),
      opts.tries ?? 3,
      log,
      "webhook",
    );
  };
}

const PRIORITY: Record<Severity, string> = { info: "3", warning: "4", urgent: "5" };

/**
 * ntfy.sh-compatible push (`POST <url>/<topic>`; ntfy is self-hostable). Only the plain-language title and body
 * travel: alert copy never contains amounts or addresses (plan §40 §5), and the topic is the user's own random
 * string. The push is a nudge; the extension fetches and verifies the signed alert itself.
 */
export function ntfySink(
  cfg: { url: string; topic: string; token?: string; minSeverity: Severity },
  opts: { fetch?: Fetch; log?: Log; tries?: number } = {},
): Sink {
  const f = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  return async (e: HubEntry) => {
    if (e.type !== "alert" || !atLeast(e.alert.severity, cfg.minSeverity)) return;
    const headers: Record<string, string> = {
      Title: e.alert.title,
      Priority: PRIORITY[e.alert.severity],
      Tags:
        e.alert.severity === "urgent"
          ? "rotating_light"
          : e.alert.severity === "warning"
            ? "warning"
            : "information_source",
    };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    await withRetry(
      () =>
        f(`${cfg.url}/${encodeURIComponent(cfg.topic)}`, {
          method: "POST",
          headers,
          body: e.alert.body,
          signal: AbortSignal.timeout(10_000),
        }),
      opts.tries ?? 3,
      log,
      "ntfy",
    );
  };
}

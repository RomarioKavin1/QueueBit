import {
  authHeader,
  parsePairing,
  verifyAlert,
  type Alert,
  type Pairing,
  type SignedAlert,
} from "@queuebit/watcher-core";
import type { KV } from "../../shared/kv";

/**
 * Pairing with a self-hosted watcher (plan §40 §5; ux-spec §3.10 "Pair a watcher"). The watcher's pairing code is
 * the JSON `{url, topic, keyId, hmacKey}` (IMPLEMENTATION-NOTES "Watcher": `keyId` lets one watcher serve several
 * devices). The browser then reads `GET <url>/v1/alerts?since=<seq>` with `QUEUEBIT-HMAC` request auth, and keeps an
 * alert only if its envelope's HMAC verifies under the shared key, so a spoofed server cannot inject an "all clear"
 * or a fake alarm. The key never leaves storage.local; it is not a spending key.
 */
export const WATCHER_PAIRING_KEY = "queuebit:watcherPairing";

export interface PairingRecord extends Pairing {
  pairedAt: number;
  /** Last hub sequence number read. */
  since: number;
  lastOkAt?: number;
  lastError?: string;
}

/** What Security › Alerts shows (no key material). */
export interface PairingView {
  url: string;
  topic: string;
  keyId: string;
  pairedAt: number;
  lastOkAt?: number;
  lastError?: string;
}

export const pairingView = (p: PairingRecord): PairingView => ({
  url: p.url,
  topic: p.topic,
  keyId: p.keyId,
  pairedAt: p.pairedAt,
  ...(p.lastOkAt ? { lastOkAt: p.lastOkAt } : {}),
  ...(p.lastError ? { lastError: p.lastError } : {}),
});

/** Parses and normalises a scanned / pasted pairing code (throws with a plain-language message). */
export function readPairingCode(text: string): Pairing {
  let p: Pairing;
  try {
    p = parsePairing(text.trim());
  } catch (e) {
    throw new Error(
      `That isn't a QueueBit watcher pairing code (${(e as Error).message.replace(/^pairing: /u, "")}). It looks like {"url", "topic", "keyId", "hmacKey"}.`,
      { cause: e },
    );
  }
  return { ...p, url: p.url.replace(/\/+$/u, "") };
}

export interface WatcherFetch {
  (
    url: string,
    init: { headers: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** One read of the paired watcher: verified alerts and retractions since the last read. */
export async function readPairedWatcher(
  p: PairingRecord,
  f: WatcherFetch,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<{ alerts: Alert[]; retracted: string[]; since: number; rejected: number }> {
  const path = "/v1/alerts";
  const res = await f(`${p.url}${path}?since=${p.since}`, {
    headers: { authorization: await authHeader(p.keyId, p.hmacKey, "GET", path, nowS) },
  });
  if (!res.ok) throw new Error(res.status === 401 ? "the watcher refused this browser's key" : `HTTP ${res.status}`);
  const body = (await res.json()) as { alerts?: SignedAlert[] };
  const alerts: Alert[] = [];
  const retracted: string[] = [];
  let since = p.since;
  let rejected = 0;
  for (const e of body.alerts ?? []) {
    // History replays are fine (dedup by id); the signature must still verify under our key. The v2 envelope signs
    // `t`, `type`, `seq` and the alert together (v1 is refused), so only a verified entry moves the cursor and a
    // replayed alert cannot be relabelled as a retraction or given a huge `seq` that would hide later alerts.
    if (
      !e ||
      typeof e !== "object" ||
      !(await verifyAlert(p.hmacKey, { v: e.v, t: e.t, type: e.type, seq: e.seq, alert: e.alert, sig: e.sig }))
    ) {
      rejected++;
      continue;
    }
    since = Math.max(since, e.seq);
    // Even a verified retraction is honoured only for alerts the watcher itself raised
    // (`AlertStore.retract(ids, "watcher")`), never this browser's own: a paired watcher is trusted for its alerts.
    if (e.type === "retract") retracted.push(e.alert.id);
    else alerts.push(e.alert);
  }
  return { alerts, retracted, since, rejected };
}

export class PairingStore {
  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<PairingRecord | undefined> {
    return this.kv.get<PairingRecord>(WATCHER_PAIRING_KEY);
  }

  async set(p: Pairing): Promise<PairingRecord> {
    const rec: PairingRecord = { ...p, pairedAt: this.now(), since: 0 };
    await this.kv.set(WATCHER_PAIRING_KEY, rec);
    return rec;
  }

  async update(patch: Partial<PairingRecord>): Promise<void> {
    const cur = await this.get();
    if (cur) await this.kv.set(WATCHER_PAIRING_KEY, { ...cur, ...patch });
  }

  remove(): Promise<void> {
    return this.kv.remove(WATCHER_PAIRING_KEY);
  }
}

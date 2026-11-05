import type { Alert } from "@leaked/watcher-core";

export interface HubEntry {
  seq: number;
  type: "alert" | "retract";
  alert: Alert;
}

export type Sink = (e: HubEntry) => void | Promise<void>;

/**
 * Fan-out of alerts to the stream subscribers and the push sinks, with a bounded history for `Last-Event-ID` /
 * `GET /v1/alerts?since=` replay. An alert id is delivered once; a reorg that drops its transaction publishes a
 * `retract` entry for it.
 */
export class Hub {
  private seq: number;
  private history: HubEntry[];
  private readonly live = new Map<string, Alert>();
  private readonly subs = new Set<Sink>();

  constructor(
    private readonly sinks: Sink[] = [],
    state?: { seq: number; history: HubEntry[] },
    private readonly capacity = 1000,
  ) {
    this.seq = state?.seq ?? 0;
    this.history = state?.history ? [...state.history] : [];
    for (const h of this.history) {
      if (h.type === "alert") this.live.set(h.alert.id, h.alert);
      else this.live.delete(h.alert.id);
    }
  }

  publish(alerts: readonly Alert[]): HubEntry[] {
    const out: HubEntry[] = [];
    for (const a of alerts) {
      if (this.live.has(a.id)) continue;
      this.live.set(a.id, a);
      out.push(this.push({ seq: ++this.seq, type: "alert", alert: a }));
    }
    return out;
  }

  retract(ids: Iterable<string>): HubEntry[] {
    const out: HubEntry[] = [];
    for (const id of ids) {
      const a = this.live.get(id);
      if (!a) continue;
      this.live.delete(id);
      out.push(this.push({ seq: ++this.seq, type: "retract", alert: a }));
    }
    return out;
  }

  has(id: string): boolean {
    return this.live.has(id);
  }

  since(seq: number): HubEntry[] {
    return this.history.filter((h) => h.seq > seq);
  }

  subscribe(s: Sink): () => void {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  get subscribers(): number {
    return this.subs.size;
  }

  snapshot(): { seq: number; history: HubEntry[] } {
    return { seq: this.seq, history: [...this.history] };
  }

  private push(e: HubEntry): HubEntry {
    this.history.push(e);
    if (this.history.length > this.capacity) this.history.splice(0, this.history.length - this.capacity);
    for (const s of [...this.subs, ...this.sinks]) {
      try {
        void Promise.resolve(s(e)).catch(() => {});
      } catch {
        // a broken subscriber never blocks the others
      }
    }
    return e;
  }
}

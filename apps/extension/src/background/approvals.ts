import { StorageKeys, type KV } from "../shared/kv";
import type { Approval, ApprovalKind, ApprovalStatus } from "../shared/types";

/**
 * Approval requests (plan §30 §3.6): persisted in storage.session so a service-worker restart can pick them up again
 * (ux-spec E-90), keyed by an approval id that the approval window gets in its URL.
 */
export class ApprovalStore {
  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  async all(): Promise<Record<string, Approval>> {
    return (await this.kv.get<Record<string, Approval>>(StorageKeys.approvals)) ?? {};
  }

  private async save(all: Record<string, Approval>): Promise<void> {
    await this.kv.set(StorageKeys.approvals, all);
  }

  async get(id: string): Promise<Approval | undefined> {
    return (await this.all())[id];
  }

  /**
   * A request id is `<tab>:<frame>:<page id>`; the page picks the last part, and a tab keeps its id across navigations,
   * so the lookup is scoped to the origin as well. A site can never reach another site's approval.
   */
  async findByRequestId(origin: string, requestId: string): Promise<Approval | undefined> {
    return Object.values(await this.all()).find((a) => a.origin === origin && a.requestIds.includes(requestId));
  }

  async findPending(origin: string, kind: ApprovalKind): Promise<Approval | undefined> {
    return Object.values(await this.all()).find(
      (a) => a.status === "pending" && a.origin === origin && a.kind === kind,
    );
  }

  async pending(): Promise<Approval[]> {
    return Object.values(await this.all()).filter((a) => a.status === "pending");
  }

  async create(init: ApprovalInit, requestId: string) {
    const approval: Approval = {
      ...init,
      id: crypto.randomUUID(),
      requestIds: [requestId],
      status: "pending",
      createdAt: this.now(),
    };
    await this.save({ ...(await this.all()), [approval.id]: approval });
    return approval;
  }

  async update(id: string, patch: Partial<Approval>): Promise<Approval | undefined> {
    const all = await this.all();
    const cur = all[id];
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id };
    all[id] = next;
    await this.save(all);
    return next;
  }

  async attachRequest(id: string, requestId: string): Promise<void> {
    const a = await this.get(id);
    if (a && !a.requestIds.includes(requestId)) await this.update(id, { requestIds: [...a.requestIds, requestId] });
  }

  /** Drop resolved approvals older than `maxAgeMs` (kept briefly so a replayed request gets the same answer). */
  async prune(maxAgeMs = 5 * 60_000): Promise<void> {
    const all = await this.all();
    const cutoff = this.now() - maxAgeMs;
    let changed = false;
    for (const [id, a] of Object.entries(all)) {
      if (a.status !== "pending" && (a.resolvedAt ?? 0) < cutoff) {
        delete all[id];
        changed = true;
      }
    }
    if (changed) await this.save(all);
  }
}

export type ApprovalOutcome = Exclude<ApprovalStatus, "pending">;

export type ApprovalInit = Pick<
  Approval,
  "kind" | "origin" | "chainId" | "firstVisit" | "embedded" | "topOrigin" | "tx" | "sessionMiss"
>;

/**
 * Upper bound on approvals waiting at once. Each one is a window, and a page can embed any number of cross-origin
 * frames that all ask to connect, so without a bound one site could carpet the screen with approval windows.
 */
export const MAX_PENDING_APPROVALS = 3;

export class TooManyPendingError extends Error {
  constructor() {
    super("QueueBit already has open requests waiting for you. Answer or close them first.");
    this.name = "TooManyPendingError";
  }
}

export interface ApprovalWindows {
  /** Open the approval window for `approvalId`; returns its window id. */
  open(approvalId: string): Promise<number | undefined>;
  /** Bring an existing window to the front. Returns false if it no longer exists. */
  focus(windowId: number): Promise<boolean>;
  /** Whether the window still exists (without focusing it). */
  exists(windowId: number): Promise<boolean>;
}

/**
 * Joins dapp requests to approvals and wakes them when the user decides. Waiters live in memory; the decisions live in
 * storage.session, so after a service-worker restart a replayed request (same request id) finds its approval again.
 */
export class ApprovalBroker {
  private readonly waiters = new Map<string, Array<(o: ApprovalOutcome) => void>>();

  constructor(
    readonly store: ApprovalStore,
    private readonly windows: ApprovalWindows,
    private readonly now: () => number = Date.now,
  ) {}

  /** Requests arrive concurrently; the find-or-create step runs one at a time so the cap and the dedup hold. */
  private queue: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async request(init: ApprovalInit, requestId: string): Promise<ApprovalOutcome> {
    return (await this.requestRecord(init, requestId)).status as ApprovalOutcome;
  }

  /** Like `request`, but resolves with the finished approval record (its `result` / `denial`). */
  async requestRecord(init: ApprovalInit, requestId: string): Promise<Approval> {
    const approval = await this.serialized(async () => {
      let approval = await this.store.findByRequestId(init.origin, requestId);
      if (approval && approval.status !== "pending") return approval;

      // A repeated connect request joins the one waiting; every transaction is its own approval.
      if (!approval && init.kind === "connect") {
        approval = await this.store.findPending(init.origin, init.kind);
        if (approval) await this.store.attachRequest(approval.id, requestId);
      }

      if (!approval) {
        if ((await this.store.pending()).length >= MAX_PENDING_APPROVALS) throw new TooManyPendingError();
        approval = await this.store.create(init, requestId);
        const windowId = await this.windows.open(approval.id);
        if (windowId !== undefined) await this.store.update(approval.id, { windowId });
      } else if (approval.windowId === undefined || !(await this.windows.focus(approval.windowId))) {
        const windowId = await this.windows.open(approval.id);
        if (windowId !== undefined) await this.store.update(approval.id, { windowId });
      }
      return approval;
    });
    if (approval.status !== "pending") return approval;

    const id = approval.id;
    await new Promise<ApprovalOutcome>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
    return (await this.store.get(id)) ?? { ...approval, status: "rejected" };
  }

  async resolve(
    id: string,
    outcome: ApprovalOutcome,
    extra: Pick<Approval, "result" | "denial"> = {},
  ): Promise<Approval | undefined> {
    const cur = await this.store.get(id);
    if (!cur || cur.status !== "pending") return cur;
    const next = await this.store.update(id, { ...extra, status: outcome, resolvedAt: this.now() });
    for (const w of this.waiters.get(id) ?? []) w(outcome);
    this.waiters.delete(id);
    return next;
  }

  /** The user closed the approval window: that is a rejection. */
  async onWindowRemoved(windowId: number): Promise<void> {
    for (const a of await this.store.pending()) {
      if (a.windowId === windowId) await this.resolve(a.id, "rejected");
    }
  }

  /**
   * Called once when the service worker starts. Any approval still pending was created by a previous SW instance:
   * mark it resumed (the window says "Picking up where you left off") and make sure its window is still open.
   */
  async resumeAfterRestart(): Promise<void> {
    await this.store.prune();
    for (const a of await this.store.pending()) {
      await this.store.update(a.id, { resumedAt: this.now() });
      if (a.windowId === undefined || !(await this.windows.exists(a.windowId))) {
        const windowId = await this.windows.open(a.id);
        if (windowId !== undefined) await this.store.update(a.id, { windowId });
      }
    }
  }

  hasWaiters(id: string): boolean {
    return (this.waiters.get(id)?.length ?? 0) > 0;
  }
}

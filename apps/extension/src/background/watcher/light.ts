import type { Address, Hex } from "viem";
import {
  WatcherCore,
  decodeLogs,
  type AccountRoles,
  type Alert,
  type CoreState,
  type RpcLog,
  type WatchTargets,
} from "@leaked/watcher-core";
import { aaNetwork } from "../aa/payments";
import type { AccountPlan } from "../account";
import type { CodeReader, DeployBlocks } from "../deployBlock";
import type { KV } from "../../shared/kv";

/**
 * The watcher's light mode (plan §40 §5 "In-extension light mode"; plan §30 §6.5): a `chrome.alarms` job in the
 * service worker reads the account's own events with `eth_getLogs` from its deployment block (then from a cursor),
 * runs them through `@leaked/watcher-core` (the same rules and copy as the self-hosted watcher), and hands new alerts
 * to the caller (notification, badge, the in-app list). The core's state (deadlines, dedup) is persisted, so an SW
 * restart neither repeats nor loses alerts.
 *
 * Limits, stated in Security › Alerts: only while the browser runs; a blocked everyday payment leaves no log, so it
 * is not detected here (the self-hosted watcher reads the blocks for that); reorgs deeper than `confirmations` are
 * not rewound.
 */
export const WATCHER_STATE_KEY = (chainId: number) => `leaked:watcher:${chainId}`;

export interface WatcherState {
  account: Address;
  /** Last block processed. */
  cursor?: string;
  core?: CoreState;
  lastPollAt?: number;
  lastError?: string;
}

export interface LightClient extends CodeReader {
  request(a: { method: string; params: unknown[] }): Promise<unknown>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export interface WatcherLightDeps {
  kv: KV;
  deployBlocks: DeployBlocks;
  client(chainId: number): LightClient;
  plan(chainId: number): Promise<AccountPlan | undefined>;
  roles(chainId: number): Promise<AccountRoles>;
  /** Did this browser start it (its own Vault requests and payments)? undefined = unknown. */
  initiated(chainId: number): Promise<(ref: { txHash?: Hex; opId?: Hex }) => boolean | undefined>;
  now?: () => number;
  /** Blocks behind the head before a block is read (default 1). */
  confirmations?: number;
  /** eth_getLogs page size (halved on refusal). */
  maxRange?: number;
}

export function watchTargets(plan: AccountPlan): WatchTargets {
  const roleSigners = [plan.vaultSigner, plan.recoverySigner]
    .filter((a): a is Address => !!a && !/^0x0{40}$/iu.test(a))
    .map((address) => ({ address, account: plan.address }));
  if (plan.backend === "4337") {
    const dep = aaNetwork(plan.chainId)?.aa;
    return {
      chainId: plan.chainId,
      accounts: [{ address: plan.address, backend: "4337" }],
      ...(dep ? { modules: [dep.hook, dep.executor], entryPoint: dep.entryPoint } : {}),
    };
  }
  return { chainId: plan.chainId, accounts: [{ address: plan.address, backend: "frame" }], roleSigners };
}

export class WatcherLight {
  constructor(private readonly d: WatcherLightDeps) {}

  async state(chainId: number): Promise<WatcherState | undefined> {
    return this.d.kv.get<WatcherState>(WATCHER_STATE_KEY(chainId));
  }

  /**
   * One poll: new alerts (deduplicated against everything raised before), and the next deadline (unix seconds) the
   * caller should wake up for (`chrome.alarms.create(name, {when})`).
   */
  async poll(chainId: number): Promise<{ alerts: Alert[]; nextDeadline?: number; processedTo?: bigint }> {
    const plan = await this.d.plan(chainId);
    if (!plan) return { alerts: [] };
    const c = this.d.client(chainId);
    const nowS = Math.floor((this.d.now ?? Date.now)() / 1000);
    let st = await this.state(chainId);
    if (!st || st.account.toLowerCase() !== plan.address.toLowerCase()) st = { account: plan.address };

    const [rolesNow, initiated] = await Promise.all([this.d.roles(chainId), this.d.initiated(chainId)]);
    const core = new WatcherCore({
      targets: watchTargets(plan),
      ...(st.core ? { state: st.core } : {}),
      roles: () => rolesNow,
      initiated: (_a, ref) => initiated(ref),
    });

    const save = async (patch: Partial<WatcherState>) => {
      st = { ...st!, ...patch, core: core.snapshot(), lastPollAt: (this.d.now ?? Date.now)() };
      await this.d.kv.set(WATCHER_STATE_KEY(chainId), st);
    };

    try {
      const head = await c.getBlockNumber();
      const to = head - BigInt(this.d.confirmations ?? 1);
      const from =
        st.cursor !== undefined
          ? BigInt(st.cursor) + 1n
          : await this.d.deployBlocks.get(
              chainId,
              plan.address,
              c,
              plan.activation ? { activationTx: plan.activation.txHash } : undefined,
            );
      const alerts: Alert[] = [];
      if (from !== undefined && from <= to) {
        const logs = await this.getLogs(c, core.index.logAddresses(), from, to);
        const events = decodeLogs(logs, core.index);
        // ethrex adds the block timestamp to each log; other nodes may not.
        const ts = new Map<bigint, number>();
        for (const e of events) {
          if (e.timestamp !== undefined || ts.has(e.blockNumber)) continue;
          ts.set(e.blockNumber, Number((await c.getBlock({ blockNumber: e.blockNumber })).timestamp));
        }
        const timed = events.map((e) =>
          e.timestamp === undefined ? { ...e, timestamp: ts.get(e.blockNumber) ?? nowS } : e,
        );
        alerts.push(...core.ingest(timed, nowS));
        alerts.push(...core.tick(nowS));
        const nextDeadline = core.nextDeadline();
        await save({ cursor: to.toString(), lastError: undefined });
        return { alerts, ...(nextDeadline !== undefined ? { nextDeadline } : {}), processedTo: to };
      }
      alerts.push(...core.tick(nowS));
      const nextDeadline = core.nextDeadline();
      await save({ lastError: undefined });
      return { alerts, ...(nextDeadline !== undefined ? { nextDeadline } : {}) };
    } catch (e) {
      await save({ lastError: (e as Error).message.split("\n")[0] });
      throw e;
    }
  }

  /** Deadline ticks only (a `chrome.alarms` deadline fired between polls). */
  async tick(chainId: number): Promise<Alert[]> {
    const plan = await this.d.plan(chainId);
    const st = await this.state(chainId);
    if (!plan || !st?.core) return [];
    const core = new WatcherCore({ targets: watchTargets(plan), state: st.core });
    const alerts = core.tick(Math.floor((this.d.now ?? Date.now)() / 1000));
    await this.d.kv.set(WATCHER_STATE_KEY(chainId), { ...st, core: core.snapshot() });
    return alerts;
  }

  private async getLogs(c: LightClient, addresses: Address[], from: bigint, to: bigint): Promise<RpcLog[]> {
    if (addresses.length === 0) return [];
    const out: RpcLog[] = [];
    let range = BigInt(this.d.maxRange ?? 5000);
    let start = from;
    while (start <= to) {
      const end = start + range - 1n < to ? start + range - 1n : to;
      try {
        const page = (await c.request({
          method: "eth_getLogs",
          params: [{ address: addresses, fromBlock: hex(start), toBlock: hex(end) }],
        })) as RpcLog[];
        out.push(...page);
        start = end + 1n;
      } catch (e) {
        if (range === 1n) throw e;
        range = range / 2n;
      }
    }
    return out;
  }
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

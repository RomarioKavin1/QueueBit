import { DEFAULT_CHAIN_ID, findNetwork } from "../shared/chains";
import { StorageKeys, type KV } from "../shared/kv";
import {
  AUTO_LOCK_CHOICES,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  type Settings,
  type SetupState,
  type Theme,
} from "../shared/types";

/** Settings and the onboarding choices, write-through to storage.local (plan §30 §2.2 SettingsController). */
export class SettingsStore {
  constructor(private readonly kv: KV) {}

  async get(): Promise<Settings> {
    const stored = await this.kv.get<Partial<Settings>>(StorageKeys.settings);
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    if (!findNetwork(merged.selectedChainId)) merged.selectedChainId = DEFAULT_CHAIN_ID;
    return merged;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()) };
    if (patch.selectedChainId !== undefined) {
      if (!findNetwork(patch.selectedChainId)) throw new Error("Unknown network");
      next.selectedChainId = patch.selectedChainId;
    }
    if (patch.autoLockMinutes !== undefined) {
      if (!AUTO_LOCK_CHOICES.includes(patch.autoLockMinutes)) throw new Error("Unsupported auto-lock time");
      next.autoLockMinutes = patch.autoLockMinutes;
    }
    if (patch.theme !== undefined) {
      if (!(["system", "light", "dark"] as Theme[]).includes(patch.theme)) throw new Error("Unknown theme");
      next.theme = patch.theme;
    }
    if (patch.anonRpc !== undefined) {
      if (typeof patch.anonRpc !== "boolean") throw new Error("Unknown private-connection setting");
      next.anonRpc = patch.anonRpc;
    }
    await this.kv.set(StorageKeys.settings, next);
    return next;
  }

  async getSetup(): Promise<SetupState> {
    return { ...DEFAULT_SETUP, ...(await this.kv.get<Partial<SetupState>>(StorageKeys.setup)) };
  }

  async updateSetup(patch: Partial<SetupState>): Promise<SetupState> {
    const next = { ...(await this.getSetup()) };
    for (const k of ["completedAt", "backupConfirmedAt"] as const) {
      const v = patch[k];
      if (v !== undefined) {
        if (!Number.isFinite(v)) throw new Error(`Bad ${k}`);
        next[k] = v;
      }
    }
    await this.kv.set(StorageKeys.setup, next);
    return next;
  }

  async clearSetup(): Promise<void> {
    await this.kv.remove(StorageKeys.setup);
  }
}

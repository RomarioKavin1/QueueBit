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
    await this.kv.set(StorageKeys.settings, next);
    return next;
  }

  async getSetup(): Promise<SetupState> {
    return { ...DEFAULT_SETUP, ...(await this.kv.get<Partial<SetupState>>(StorageKeys.setup)) };
  }

  async updateSetup(patch: Partial<SetupState>): Promise<SetupState> {
    const next = { ...(await this.getSetup()) };
    if (patch.dailyLimitUsd !== undefined || patch.perPaymentUsd !== undefined) {
      const daily = patch.dailyLimitUsd ?? next.dailyLimitUsd;
      const perPayment = patch.perPaymentUsd ?? next.perPaymentUsd;
      const err = validateLimits(daily, perPayment);
      if (err) throw new Error(err);
      next.dailyLimitUsd = daily;
      next.perPaymentUsd = perPayment;
    }
    if (patch.completedAt !== undefined) next.completedAt = patch.completedAt;
    if (patch.vaultSkippedAt !== undefined) next.vaultSkippedAt = patch.vaultSkippedAt;
    if (patch.recoverySkippedAt !== undefined) next.recoverySkippedAt = patch.recoverySkippedAt;
    await this.kv.set(StorageKeys.setup, next);
    return next;
  }

  async clearSetup(): Promise<void> {
    await this.kv.remove(StorageKeys.setup);
  }
}

/** ux-spec §3.1.3 validation. Returns user-facing copy, or undefined if valid. */
export function validateLimits(dailyUsd: number, perPaymentUsd: number): string | undefined {
  if (!Number.isFinite(dailyUsd) || dailyUsd < 10) return "The daily limit must be at least $10.";
  if (!Number.isFinite(perPaymentUsd) || perPaymentUsd <= 0) return "The per-payment limit must be more than $0.";
  if (perPaymentUsd > dailyUsd) return "The per-payment limit can't be more than the daily limit.";
  if (dailyUsd > 1_000_000) return "That limit is too high.";
  return undefined;
}

import { describe, expect, it } from "vitest";
import { linkSecretOf, newChannel } from "@queuebit/relay-client";
import { KeyringController } from "../../src/background/keyring";
import { SettingsStore } from "../../src/background/settings";
import { MemoryKV } from "../../src/shared/kv";
import { DEFAULT_SETTINGS, DEFAULT_SETUP, type WalletState } from "../../src/shared/types";
import { checklistItems } from "../../src/pages/common/SecureChecklist";
import { V2_DEFAULTS } from "../../src/pages/app/Onboarding";
import type { AccountStatus } from "../../src/shared/views";

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe("onboarding v2: settings", () => {
  it("stores the relay link (validated) and the checklist marks", async () => {
    const s = new SettingsStore(new MemoryKV());
    const secret = linkSecretOf(newChannel());
    const next = await s.updateSetup({ relayLink: { secret, at: 1 }, backupConfirmedAt: 2, defaultsAppliedAt: 3 });
    expect(next.relayLink).toEqual({ secret, at: 1 });
    expect(next.backupConfirmedAt).toBe(2);
    await expect(s.updateSetup({ relayLink: { secret: "short", at: 1 } })).rejects.toThrow(/relay link/u);
    await expect(s.updateSetup({ limitReviewedAt: Number.NaN })).rejects.toThrow();
  });

  it("applies the $50/day defaults through the same validation as the limit screen", async () => {
    const s = new SettingsStore(new MemoryKV());
    const next = await s.updateSetup(V2_DEFAULTS);
    expect(next).toMatchObject({ dailyLimitUsd: 50, perPaymentUsd: 50, recipientMode: "open" });
  });

  it("has an air-gapped (offline phone) setting, off by default", async () => {
    const s = new SettingsStore(new MemoryKV());
    expect((await s.get()).airGapped).toBeFalsy();
    expect((await s.update({ airGapped: true })).airGapped).toBe(true);
    await expect(s.update({ airGapped: "yes" as never })).rejects.toThrow();
  });
});

describe("onboarding v2: backup words later", () => {
  it("reveals the everyday words only with the password", async () => {
    const k = new KeyringController(new MemoryKV(), new MemoryKV(), { scrypt: FAST });
    const { mnemonic } = await k.create("correct-horse-battery");
    expect(await k.revealWords("correct-horse-battery")).toBe(mnemonic);
    await expect(k.revealWords("wrong-password")).rejects.toThrow(/didn't work/u);
  });
});

describe("onboarding v2: Secure-your-wallet checklist", () => {
  const state = (setup: Partial<WalletState["setup"]> = {}): WalletState => ({
    initialized: true,
    unlocked: true,
    settings: DEFAULT_SETTINGS,
    setup: { ...DEFAULT_SETUP, ...V2_DEFAULTS, ...setup },
  });
  const deployed = { deployed: true } as AccountStatus;

  it("starts at 0 of 4, with a one-line reason for each", () => {
    const items = checklistItems(state(), deployed);
    expect(items.map((i) => i.id)).toEqual(["backup", "recovery", "guardian", "limit"]);
    expect(items.every((i) => !i.done && i.why.length > 10)).toBe(true);
    expect(items.filter((i) => i.optional).map((i) => i.id)).toEqual(["guardian", "limit"]);
    expect(items.find((i) => i.id === "limit")!.why).toContain("$50");
  });

  it("ticks items off as they are done or skipped", () => {
    const items = checklistItems(state({ backupConfirmedAt: 1, guardianSkippedAt: 1, limitReviewedAt: 1 }), {
      ...deployed,
      recoverySigner: "0x0000000000000000000000000000000000000001",
    });
    expect(items.every((i) => i.done)).toBe(true);
    // A Recovery key tested before activation counts once it is part of the account.
    expect(checklistItems(state({ recovery: { testedAt: 1 } as never }), deployed)[1]!.done).toBe(false);
  });
});

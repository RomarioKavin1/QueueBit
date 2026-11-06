import { describe, expect, it } from "vitest";
import { getAddress, type Abi, type Address } from "viem";
import { TargetIndex, accountAbi, decodeLog, decodeLogs, decodeRevertName, modulesAbi } from "../src/index.js";
import { errorData, fixture, makeLog, txh } from "./helpers.js";

const OTHER: Address = getAddress("0x00000000000000000000000000000000000000bb");
const RECOVERY: Address = "0x0000000000000000000000000000000000000ec0";
const idx = new TargetIndex({
  chainId: 1337,
  accounts: [{ address: fixture.account }],
  modules: [fixture.keystore, fixture.hook, RECOVERY],
});

describe("real devnet logs (chain 1337, sessions-live)", () => {
  const events = decodeLogs(fixture.logs, idx);

  it("decodes every log of the account run, in chain order", () => {
    expect(events).toHaveLength(fixture.logs.length);
    const types = events.map((e) => e.event.type);
    expect(types).toContain("moduleInstalled");
    expect(types).toContain("keyAdded");
    expect(types).toContain("policySet");
    expect(types).toContain("sessionTokenSet");
    expect(types).toContain("dailyCapSet");
    expect(types).toContain("sessionSpend");
    expect(events.every((e) => e.account === getAddress(fixture.account) && e.backend === "frame")).toBe(true);
    const blocks = events.map((e) => e.blockNumber);
    expect([...blocks].sort((a, b) => (a < b ? -1 : 1))).toEqual(blocks);
  });

  it("keeps block metadata and the session's token spend", () => {
    const tokenSpend = events.find((e) => e.event.type === "sessionSpend" && e.event.token)!;
    expect(tokenSpend.blockNumber).toBe(6083n);
    expect(tokenSpend.timestamp).toBeGreaterThan(1_700_000_000);
    expect(tokenSpend.event).toMatchObject({ amount: 100n * 10n ** 18n, spentToday: 100n * 10n ** 18n });
  });
});

describe("filtering", () => {
  it("drops a shared module's events for accounts it does not watch, and removed logs", () => {
    const foreign = makeLog(
      modulesAbi as Abi,
      "KeyRemoved",
      { account: OTHER, keyId: txh(1) },
      { address: fixture.keystore },
    );
    expect(decodeLog(foreign, idx)).toBeNull();
    expect(decodeLog({ ...fixture.logs[0]!, removed: true }, idx)).toBeNull();
    expect(decodeLog({ ...fixture.logs[0]!, address: OTHER }, idx)).toBeNull();
  });

  it("decodes guardian recovery and account upgrades", () => {
    const approved = makeLog(
      modulesAbi as Abi,
      "Approved",
      { account: fixture.account, id: txh(9), guardian: OTHER, approvals: 2, readyAt: 1_800_000_000n },
      { address: RECOVERY },
    );
    expect(decodeLog(approved, idx)!.event).toEqual({
      type: "recoveryApproved",
      id: txh(9),
      guardian: OTHER,
      approvals: 2,
      readyAt: 1_800_000_000,
    });
    const up = makeLog(accountAbi as Abi, "Upgraded", { implementation: OTHER }, { address: fixture.account });
    expect(decodeLog(up, idx)!.event).toEqual({ type: "upgraded", impl: OTHER });
  });

  it("logAddresses covers the accounts and the modules once", () => {
    expect(idx.logAddresses()).toHaveLength(4);
  });
});

describe("decodeRevertName", () => {
  it("names the stack's errors (hook, keystore)", () => {
    expect(decodeRevertName(errorData(modulesAbi as Abi, "ExpiredKey", []))).toBe("ExpiredKey");
    expect(decodeRevertName(errorData(accountAbi as Abi, "ValidationFailed", []))).toBe("ValidationFailed");
    expect(decodeRevertName("0x12345678")).toBeUndefined();
    expect(decodeRevertName(undefined)).toBeUndefined();
  });
});

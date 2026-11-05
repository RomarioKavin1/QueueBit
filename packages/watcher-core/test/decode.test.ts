import { describe, expect, it } from "vitest";
import { getAddress, type Abi, type Address } from "viem";
import {
  TargetIndex,
  blockReasonOf,
  decodeLog,
  decodeLogs,
  decodeRevertName,
  entryPointAbi,
  frameAccountAbi,
  moduleAbi,
  roleSignerAbi,
} from "../src/index.js";
import { errorData, fixture, makeLog, txh } from "./helpers.js";

const ACC4337: Address = getAddress("0x00000000000000000000000000000000000a4337");
const HOOK: Address = "0x0000000000000000000000000000000000000100";
const EXEC: Address = "0x0000000000000000000000000000000000000e00";
const EP: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const ROLE: Address = "0x0000000000000000000000000000000000000075";

const idx = new TargetIndex({
  chainId: 1337,
  accounts: [
    { address: fixture.account, backend: "frame" },
    { address: ACC4337, backend: "4337" },
  ],
  modules: [HOOK, EXEC],
  entryPoint: EP,
  roleSigners: [{ address: ROLE, account: fixture.account }],
});

describe("frame backend: real devnet logs (chain 1337)", () => {
  const events = decodeLogs(fixture.logs, idx);

  it("decodes every log of the account run (creation, hot payments, guardian pause/resume)", () => {
    // All but OpenZeppelin's `Initialized`, which the generator leaves out of the watched ABI.
    expect(events).toHaveLength(fixture.logs.length - 1);
    const types = events.map((e) => e.event.type);
    expect(types).toContain("upgraded");
    expect(types).toContain("hotKeyRotated");
    expect(types).toContain("guardianSet");
    expect(types).toContain("frozen");
    expect(types).toContain("unfrozen");
    expect(
      events.every((e) => e.account === "0xe8a92798A23A16fe18C343Fc4fa54a4E7aC4ae8c" && e.backend === "frame"),
    ).toBe(true);
  });

  it("keeps block metadata (number, timestamp from ethrex's blockTimestamp, log index)", () => {
    const frozen = events.find((e) => e.event.type === "frozen")!;
    expect(frozen.blockNumber).toBe(854n);
    expect(frozen.timestamp).toBeGreaterThan(1_700_000_000);
    expect(frozen.event).toMatchObject({ by: "0x6424536c7aE201C84C56cdA9cc3676D4Bd51Accc" });
    // A guardian pause lasts 72 h from the block.
    expect((frozen.event as { until: number }).until - frozen.timestamp!).toBe(72 * 3600);
  });

  it("ignores logs of other addresses and removed logs", () => {
    const other = { ...fixture.logs[0]!, address: "0x0000000000000000000000000000000000000001" as Address };
    expect(decodeLog(other, idx)).toBeNull();
    expect(decodeLog({ ...fixture.logs[0]!, removed: true }, idx)).toBeNull();
  });

  it("decodes queue events with the kind name", () => {
    const opId = txh(0xabc);
    const l = makeLog(frameAccountAbi as Abi, "Queued", { opId, kind: 1, eta: 2000 }, { address: fixture.account });
    expect(decodeLog(l, idx)?.event).toEqual({ type: "queued", opId, kind: "loosen", eta: 2000 });
    const c = makeLog(
      frameAccountAbi as Abi,
      "QueueCancelled",
      { opId, by: fixture.account },
      { address: fixture.account },
    );
    expect(decodeLog(c, idx)?.event).toMatchObject({ type: "queueCancelled", opId });
  });
});

describe("4337 backend", () => {
  it("attributes module events to the indexed account, and only for watched 4337 accounts", () => {
    const l = makeLog(moduleAbi as Abi, "Frozen", { account: ACC4337, by: EXEC, until: 99 }, { address: HOOK });
    const e = decodeLog(l, idx)!;
    expect(e.account).toBe(ACC4337);
    expect(e.backend).toBe("4337");
    expect(e.event).toEqual({ type: "frozen", by: EXEC, until: 99 });
    const stranger = makeLog(
      moduleAbi as Abi,
      "Frozen",
      { account: "0x0000000000000000000000000000000000000bad", by: EXEC, until: 99 },
      { address: HOOK },
    );
    expect(decodeLog(stranger, idx)).toBeNull();
  });

  it("maps the bytes32 vault pk of a rotation and the byRecovery flag", () => {
    const pk = txh(0x77);
    const r = makeLog(
      moduleAbi as Abi,
      "VaultRotationStarted",
      { account: ACC4337, newVaultPk: pk, eta: 5 },
      { address: EXEC },
    );
    expect(decodeLog(r, idx)?.event).toEqual({ type: "vaultRotationStarted", newVault: pk, eta: 5 });
    const c = makeLog(
      moduleAbi as Abi,
      "QueueCancelled",
      { account: ACC4337, opId: pk, byRecovery: true },
      { address: EXEC },
    );
    expect(decodeLog(c, idx)?.event).toEqual({ type: "queueCancelled", opId: pk, byRecovery: true });
  });

  it("turns an EntryPoint UserOperationRevertReason with OverCap into an over-limit hotBlocked", () => {
    const revertReason = errorData(moduleAbi as Abi, "OverCap", [300_000_000n, 250_000_000n]);
    const l = makeLog(
      entryPointAbi as Abi,
      "UserOperationRevertReason",
      { userOpHash: txh(1), sender: ACC4337, nonce: 0n, revertReason },
      { address: EP },
    );
    expect(decodeLog(l, idx)?.event).toEqual({ type: "hotBlocked", reason: "over-limit", errorName: "OverCap" });
  });

  it("ignores revert reasons of senders that are not watched 4337 accounts", () => {
    const l = makeLog(
      entryPointAbi as Abi,
      "UserOperationRevertReason",
      { userOpHash: txh(1), sender: fixture.account, nonce: 0n, revertReason: "0x" },
      { address: EP },
    );
    expect(decodeLog(l, idx)).toBeNull();
  });
});

describe("role signers and errors", () => {
  it("attributes staking events to the served account", () => {
    const l = makeLog(roleSignerAbi as Abi, "StakeUnlocked", {}, { address: ROLE });
    expect(decodeLog(l, idx)).toMatchObject({
      account: fixture.account,
      event: { type: "roleSignerStake", what: "unlocked" },
    });
  });

  it("decodes revert names of both backends and maps them to reasons", () => {
    expect(decodeRevertName(errorData(frameAccountAbi as Abi, "OverCap", [1n, 0n]))).toBe("OverCap");
    expect(decodeRevertName(errorData(moduleAbi as Abi, "OverDailyCap", [1n, 0n]))).toBe("OverDailyCap");
    expect(decodeRevertName("0xdeadbeef")).toBeUndefined();
    expect(blockReasonOf("NotAllowed")).toBe("not-allowed");
    expect(blockReasonOf("HotFrozen")).toBe("paused");
    expect(blockReasonOf("PerTxMaxExceeded")).toBe("per-payment-limit");
    expect(blockReasonOf("Whatever")).toBe("other");
  });

  it("lists the log addresses to fetch", () => {
    const a = idx.logAddresses().map((x) => x.toLowerCase());
    expect(a).toContain(fixture.account.toLowerCase());
    expect(a).toContain(EP.toLowerCase());
    expect(a).not.toContain(ACC4337.toLowerCase()); // 4337 accounts emit nothing of ours themselves
  });
});

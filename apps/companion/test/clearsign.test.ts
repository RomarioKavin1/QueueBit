import { SCHEME_ID } from "@leaked/pq-signer";
import { encodeSignRequest, toHex } from "@leaked/ur";
import { describe, expect, it } from "vitest";
import {
  RequestRejected,
  reviewRequest,
  reviewRequestBytes,
  updateSnapshots,
  type Review,
} from "../src/core/clearsign.js";
import type { DeviceContext } from "../src/core/types.js";
import {
  ACCOUNT,
  ALICE,
  MALLORY,
  USDC,
  blockPermit2,
  ethSend,
  feePolicy,
  trustVerifier,
  limitRaise,
  lockdown,
  lyingWithdrawal,
  noteKeys,
  recipientMode,
  recovery,
  rotation,
  typedRegistrations,
  unknownCall,
  usdcWithdrawal,
  vault,
} from "./fixtures/requests.js";

const ctx = (over: Partial<DeviceContext> = {}): DeviceContext => ({
  mode: "vault",
  publicKey: vault.pk,
  schemeId: SCHEME_ID,
  payerAddress: vault.payer,
  addressBook: [{ id: "1", name: "Alice", address: ALICE, chains: [], addedAt: 0 }],
  snapshots: [],
  ...over,
});

function rejects(f: () => unknown, code: string): RequestRejected {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RequestRejected);
    expect((e as RequestRejected).code).toBe(code);
    return e as RequestRejected;
  }
  throw new Error("expected a rejection");
}

describe("clear signing: the two headline flows", () => {
  it("a queued daily-limit raise reads as one sentence with the waiting period", () => {
    const r = reviewRequestBytes(limitRaise().cbor, ctx());
    // No snapshot yet: the headline carries the signed value only; the browser's "from" is in the row, labelled.
    expect(r.headline).toBe("Set daily limit to $200: takes effect after a 48-hour waiting period");
    expect(r.admin?.sentence).toBe("Set daily limit to $200: takes effect after a 48-hour waiting period.");
    expect(r.actions[0]!.details).toContainEqual({ label: "Daily limit", value: "$50 (browser) → $200" });
    expect(r.approval).toBe("normal");
    expect(r.mismatch).toEqual([]);
    expect(r.unknown).toBe(false);
    const a = r.actions[0]!;
    expect(a.loosening).toBe(true);
    expect(a.timing.waitSeconds).toBe(172_800n);
    expect(a.details).toContainEqual({ label: "Per-payment limit", value: "$20 (unchanged)" });
    // The "from" values came from the browser: labelled.
    expect(r.warnings.map((w) => w.code)).toContain("browser-values");
  });

  it("a Vault withdrawal names the recipient from the address book and prices it at the pinned price", () => {
    const r = reviewRequestBytes(usdcWithdrawal().cbor, ctx());
    expect(r.headline).toBe("Send 250 USDC to Alice (0xAb58…eC9B)");
    expect(r.admin).toBeUndefined();
    const a = r.actions[0]!;
    expect(a.amount).toEqual({ text: "250 USDC", usd: { text: "$250", source: "browser" } });
    expect(a.recipient).toEqual({ address: ALICE, name: "Alice", known: true });
    expect(r.structure.account).toBe(ACCOUNT);
    expect(r.structure.path).toBe("B");
    expect(r.needsPayerSig).toBe(true);
    expect(r.approval).toBe("normal");
  });

  it("an unknown recipient is shown as an address, never with a label from the request", () => {
    const r = reviewRequestBytes(usdcWithdrawal().cbor, ctx({ addressBook: [] }));
    expect(r.headline).toBe("Send 250 USDC to 0xAb58…eC9B");
    expect(r.actions[0]!.recipient).toEqual({ address: ALICE, known: false });
  });
});

describe("digest", () => {
  it("is the @leaked/frames sig hash of the decoded payload, not anything the request says", () => {
    const b = usdcWithdrawal();
    expect(reviewRequestBytes(b.cbor, ctx()).digest).toBe(b.digest);
    expect(reviewRequestBytes(b.cbor, ctx()).structure.fingerprint).toBe(b.digest);
  });
  it("changes when one byte of the transaction changes", () => {
    const b = usdcWithdrawal();
    const payload = b.request.payload.replace(/07(?=94)/, "08") as `0x${string}`; // nonce 7 → 8 ahead of the sender
    expect(payload).not.toBe(b.request.payload);
    expect(reviewRequest({ ...b.request, payload }, ctx()).digest).not.toBe(b.digest);
  });
});

describe("warnings", () => {
  it("flags a browser description that disagrees with the decoded transaction, without showing it", () => {
    const r = reviewRequestBytes(lyingWithdrawal().cbor, ctx());
    expect(r.headline).toBe(`Send 2,500 USDC to 0x9999…9999`);
    expect(r.mismatch.sort()).toEqual(["amount", "recipient"]);
    expect(r.approval).toBe("anyway");
    const w = r.warnings[0]!;
    expect(w.code).toBe("mismatch");
    expect(w.body).toContain("amount");
    // Never the browser's values:
    expect(JSON.stringify(r.warnings)).not.toMatch(/250 USDC|Alice/);
    void MALLORY;
  });

  it("an unrecognised call needs the long-press path and shows the raw call", () => {
    const r = reviewRequestBytes(unknownCall().cbor, ctx());
    expect(r.unknown).toBe(true);
    expect(r.approval).toBe("unknown");
    expect(r.actions[0]!.unknown?.data).toMatch(/^0xdeadbeef/);
  });

  it("E-74 when the browser's settings differ from what this phone signed", () => {
    const first = reviewRequestBytes(usdcWithdrawal().cbor, ctx());
    const snaps = updateSnapshots(first, [], 1);
    expect(snaps[0]!.settings.capUsdPerDay).toBeUndefined(); // never trusted as "what this phone signed"
    expect(snaps[0]!.reported?.capUsdPerDay).toBe(50_000_000n);
    const changed = usdcWithdrawal();
    const req = { ...changed.request, policy: { ...changed.request.policy!, capUsdPerDay: 999_000_000n } };
    const r = reviewRequest(req, ctx({ snapshots: snaps }));
    expect(r.warnings.map((w) => w.code)).toContain("E-74");
  });

  it("the browser's report at the first approval does not become the trusted 'from' value", () => {
    const snaps = updateSnapshots(reviewRequestBytes(usdcWithdrawal().cbor, ctx()), [], 1);
    const r = reviewRequestBytes(limitRaise().cbor, ctx({ snapshots: snaps }));
    expect(r.headline).toBe("Set daily limit to $200: takes effect after a 48-hour waiting period");
    expect(r.warnings.map((w) => w.code)).toContain("browser-values");
  });
});

describe("other actions", () => {
  it("ETH send", () => {
    const r = reviewRequestBytes(ethSend().cbor, ctx());
    expect(r.headline).toBe("Send 0.5 ETH to Alice (0xAb58…eC9B)");
    expect(r.actions[0]!.amount?.usd?.text).toBe("$1,500");
  });
  it("Lockdown is an admin action with its consequence", () => {
    const r = reviewRequestBytes(lockdown().cbor, ctx());
    expect(r.admin?.sentence).toBe(
      "Turn on Lockdown: takes effect now. Everyday spending is switched off until the Vault issues a new everyday key.",
    );
  });
  it("new account entry points from the landed contracts", () => {
    expect(reviewRequestBytes(blockPermit2().cbor, ctx()).admin?.sentence).toBe(
      "Block 0x0000…8BA3 for everyday-key signatures: takes effect now. A blocked contract (Permit2 is blocked by default) never accepts a signature from your everyday key, so a stolen browser can't sign token permits for it.",
    );
    const fee = reviewRequestBytes(feePolicy().cbor, ctx());
    expect(fee.headline).toBe(
      "Set fee rules: priority fee up to 2 gwei, only the fee tank pays fees, fee tank 0x4444…4444: takes effect after a 48-hour waiting period",
    );
    expect(fee.actions[0]!.details).toContainEqual({ label: "Scheduled as", value: "settings change" });
  });
  it("Permit2 / EIP-3009 typed registrations are clear-signed, not unrecognised calls", () => {
    const r = reviewRequestBytes(typedRegistrations().cbor, ctx());
    expect(r.unknown).toBe(false);
    expect(r.actions.map((a) => [a.id, a.unknown === undefined])).toEqual([
      ["account.registerPermit2", true],
      ["account.registerPermit2Transfer", true],
      ["account.registerTransferAuthorization", true],
    ]);
    expect(r.actions.map((a) => a.title)).toEqual([
      "Pre-approve Alice (0xAb58…eC9B) to take up to 25 USDC through Permit2 until Jan 1, 2030, 12:00 AM UTC",
      "Pre-approve Alice (0xAb58…eC9B) to take 5 USDC once through Permit2 until Jan 1, 2030, 12:00 AM UTC",
      "Pre-approve a transfer of 1 USDC to Alice (0xAb58…eC9B), valid until Jan 1, 2030, 12:00 AM UTC",
    ]);
  });
  it("trusting a verifier is an admin action that waits", () => {
    const r = reviewRequestBytes(trustVerifier().cbor, ctx());
    expect(r.headline).toBe(
      "Allow 0x5555…5555 to accept signatures from your everyday key: takes effect after a 48-hour waiting period",
    );
    expect(r.admin).toBeDefined();
    expect(r.actions[0]!.loosening).toBe(true);
  });
  it("recipient mode: 'pay any address' is a queued loosening, 'approved only' an instant tightening", () => {
    const open = reviewRequestBytes(recipientMode("open").cbor, ctx());
    expect(open.unknown).toBe(false);
    expect(open.mismatch).toEqual([]);
    expect(open.headline).toBe("Let your everyday key pay any address: takes effect after a 48-hour waiting period");
    expect(open.actions[0]!.loosening).toBe(true);
    expect(open.admin?.consequence).toMatch(/any address, still within your daily limit/);
    const strict = reviewRequestBytes(recipientMode("strict").cbor, ctx());
    expect(strict.unknown).toBe(false);
    expect(strict.headline).toBe("Only pay approved addresses");
    expect(strict.admin?.sentence).toMatch(
      /^Only pay approved addresses: takes effect now\. Everyday payments may only go/,
    );
    expect(strict.actions[0]!.loosening).toBeUndefined();
    expect(strict.actions[0]!.details).toContainEqual({
      label: "Who everyday payments may go to",
      value: "Approved addresses only",
    });
    expect(strict.warnings.map((w) => w.code)).not.toContain("direct-loosening");
    // Sent directly (not queued), loosening is refused on chain: the phone says so before signing.
    const direct = reviewRequestBytes(recipientMode("open", false).cbor, ctx());
    expect(direct.warnings.map((w) => w.code)).toContain("direct-loosening");
  });
  it("Privacy Pools note keys (typed data) are signed by the payer key", () => {
    const r = reviewRequestBytes(noteKeys().cbor, ctx());
    expect(r.kind).toBe("typedData");
    expect(r.headline).toBe("Create the keys for private note #3.0");
    expect(r.warnings).toEqual([]);
    const other = reviewRequestBytes(noteKeys("0x000000000000000000000000000000000000dEaD").cbor, ctx());
    expect(other.warnings[0]!.code).toBe("unknown-pool");
  });
  it("a tampered typed-data schema is refused", () => {
    const n = noteKeys();
    const tampered = n.request.payload.replace(
      toHex(new TextEncoder().encode("secretIndex")).slice(2),
      toHex(new TextEncoder().encode("secretIndey")).slice(2),
    ) as `0x${string}`;
    rejects(() => reviewRequest({ ...n.request, payload: tampered }, ctx()), "E-77");
  });
});

describe("refusals", () => {
  it("E-70 another scheme, E-71 another key, E-72 unknown profile", () => {
    const b = usdcWithdrawal();
    rejects(() => reviewRequest({ ...b.request, schemeId: `0x${"11".repeat(32)}` }, ctx()), "E-70");
    rejects(() => reviewRequest({ ...b.request, expectedPk: `0x${"22".repeat(32)}` }, ctx()), "E-71");
    rejects(() => reviewRequest({ ...b.request, profileId: "some-future-profile" }, ctx()), "E-72");
    rejects(() => reviewRequest({ ...b.request, profileId: "ethrex-hegota-devnet" }, ctx()), "E-72");
  });
  it("a payer slot for someone else's fee key", () => {
    rejects(() => reviewRequestBytes(usdcWithdrawal().cbor, ctx({ payerAddress: MALLORY })), "E-78");
  });
  it("a Recovery request in Vault mode, and vice versa", () => {
    rejects(() => reviewRequestBytes(rotation().cbor, ctx()), "E-75");
    rejects(() => reviewRequestBytes(usdcWithdrawal().cbor, ctx({ mode: "recovery", publicKey: recovery.pk })), "E-75");
  });
  it("garbage payloads", () => {
    const b = usdcWithdrawal();
    rejects(() => reviewRequest({ ...b.request, payload: "0x06c0" }, ctx()), "E-77");
    rejects(() => reviewRequest({ ...b.request, payload: `${b.request.payload}00` }, ctx()), "E-77");
  });
  it("a request whose PQ slot is pre-filled", () => {
    const b = usdcWithdrawal();
    const filled = b.request.payload.replace(
      /b90e68(00)+/,
      (m) => `b90e68${"11".repeat((m.length - 6) / 2)}`,
    ) as `0x${string}`;
    expect(filled).not.toBe(b.request.payload);
    rejects(() => reviewRequest({ ...b.request, payload: filled }, ctx()), "E-77");
  });
});

describe("recovery mode", () => {
  const rctx = () => ctx({ mode: "recovery", publicKey: recovery.pk, payerAddress: undefined });
  it("renders the Vault rotation with its 7-day consequence", () => {
    const r: Review = reviewRequestBytes(rotation().cbor, rctx());
    expect(r.recoveryMode).toBe(true);
    expect(r.headline).toBe("Replace the Vault with 0x3333…3333: takes effect in 7 days");
    expect(r.admin?.sentence).toContain("The old Vault cannot cancel this.");
  });
});

describe("encoding sanity", () => {
  it("fixtures are canonical requests", () => {
    for (const b of [limitRaise(), usdcWithdrawal(), unknownCall()])
      expect(encodeSignRequest(b.request)).toEqual(b.cbor);
    void USDC;
  });
});

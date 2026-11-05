import { encodeTx, getProfile, senderFrame, type FrameTx } from "@leaked/frames";
import { SCHEME_ID } from "@leaked/pq-signer";
import { encodeSignRequest, type AdvisoryPolicy, type SignRequest } from "@leaked/ur";
import { encodeFunctionData, getAddress, type AbiFunction, type AbiParameter, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ABI,
  ERC20_ABI,
  ROLE_SIGNER_ABI,
  RequestRejected,
  reviewRequest,
  reviewRequestBytes,
  updateSnapshots,
  type Review,
} from "../src/core/clearsign.js";
import { ACCOUNT_ADMIN_IDS } from "../src/core/registry.js";
import type { DeviceContext } from "../src/core/types.js";
import {
  ACCOUNT,
  ALICE,
  MALLORY,
  POLICY,
  PROFILE_ID,
  USDC,
  VAULT_SIGNER,
  recovery,
  usdcWithdrawal,
  vault,
} from "./fixtures/requests.js";

/**
 * A malicious browser's view: the request is the only thing it controls. Every test here builds a request whose
 * display could differ from what is signed, and checks that the phone either refuses it, shows it as unknown
 * (long-press path), or shows exactly the decoded truth.
 */

const profile = getProfile(PROFILE_ID);

const ctx = (over: Partial<DeviceContext> = {}): DeviceContext => ({
  mode: "vault",
  publicKey: vault.pk,
  schemeId: SCHEME_ID,
  payerAddress: vault.payer,
  addressBook: [{ id: "1", name: "Alice", address: ALICE, chains: [], addedAt: 0 }],
  snapshots: [],
  ...over,
});

/** Re-wraps a (mutated) transaction in the fixture's request envelope. */
function rewrap(
  base: SignRequest,
  tx: FrameTx,
  over: Partial<SignRequest> = {},
): { req: SignRequest; cbor: Uint8Array } {
  const req: SignRequest = { ...base, payload: encodeTx(profile, tx), ...over };
  return { req, cbor: encodeSignRequest(req) };
}

const acct = (functionName: string, args: readonly unknown[]) =>
  encodeFunctionData({ abi: ACCOUNT_ABI, functionName: functionName as never, args: args as never });
const signer = (functionName: string, args: readonly unknown[]) =>
  encodeFunctionData({ abi: ROLE_SIGNER_ABI, functionName: functionName as never, args: args as never });
const transfer = (to: Address, amount: bigint) =>
  encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });

/** A Path-B request whose SENDER frame carries `data` to `innerTarget` through `executePQ`. */
function pathB(innerTarget: Address, data: Hex, over: Partial<SignRequest> = {}) {
  const b = usdcWithdrawal();
  const f1 = { ...b.tx.frames[1]!, data: signer("executePQ", [0n, innerTarget, data]) };
  const { intent: _drop, ...base } = b.request; // the fixture's own description would not match
  return rewrap(base, { ...b.tx, frames: [b.tx.frames[0]!, f1] }, over);
}

const rejects = (f: () => unknown, code: string) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RequestRejected);
    expect((e as RequestRejected).code).toBe(code);
    return;
  }
  throw new Error("expected a rejection");
};

describe("structure attacks (display must become 'unknown' or the request must be refused)", () => {
  it("a third frame (a hidden call from the signer with value) is shown as an unknown step, with its target and value", () => {
    const b = usdcWithdrawal();
    const extra = senderFrame(profile, { target: MALLORY, data: "0x", execution: 50_000n, value: 10n ** 18n });
    const { cbor } = rewrap(b.request, { ...b.tx, frames: [...b.tx.frames, extra] });
    const r = reviewRequestBytes(cbor, ctx());
    expect(r.unknown).toBe(true);
    expect(r.approval).toBe("unknown");
    // The hidden frame itself must be on screen: its target, its value, not just "3 steps instead of 2".
    const shown = r.actions.filter((a) => a.unknown && a.unknown.target.toLowerCase() === MALLORY.toLowerCase());
    expect(shown).toHaveLength(1);
    expect(shown[0]!.unknown!.value).toBe(10n ** 18n);
    expect(shown[0]!.details).toContainEqual({ label: "Sends", value: "1 ETH" });
  });

  it("a SENDER frame with ETH value is unknown even when its call decodes", () => {
    const b = usdcWithdrawal();
    const f1 = { ...b.tx.frames[1]!, value: 1n };
    const { cbor } = rewrap(b.request, { ...b.tx, frames: [b.tx.frames[0]!, f1] });
    expect(reviewRequestBytes(cbor, ctx()).approval).toBe("unknown");
  });

  it("a VERIFY frame that checks another signature slot is unknown", () => {
    const b = usdcWithdrawal();
    const f0 = { ...b.tx.frames[0]!, data: signer("verifyFrame", [1n]) };
    const { cbor } = rewrap(b.request, { ...b.tx, frames: [f0, b.tx.frames[1]!] });
    expect(reviewRequestBytes(cbor, ctx()).approval).toBe("unknown");
  });

  it("a request whose chain id disagrees with its transaction is refused (E-77)", () => {
    const b = usdcWithdrawal();
    rejects(() => reviewRequest({ ...b.request, chainId: 1n }, ctx()), "E-72");
    const { req } = rewrap(b.request, { ...b.tx, chainId: 1n });
    rejects(() => reviewRequest(req, ctx()), "E-77");
  });

  it("relay nested inside executePQ (a second hop) is unknown", () => {
    const inner = signer("relay", [
      ACCOUNT,
      acct("vaultExecute", [[{ target: USDC, value: 0n, data: transfer(MALLORY, 1n) }], 0n]),
    ]);
    const { cbor } = pathB(VAULT_SIGNER, inner);
    const r = reviewRequestBytes(cbor, ctx());
    expect(r.approval).toBe("unknown");
    expect(r.headline).not.toMatch(/Send/);
  });

  it("executePQ nested inside executePQ is unknown", () => {
    const inner = signer("executePQ", [0n, ACCOUNT, acct("vaultEnableBunker", [])]);
    expect(reviewRequestBytes(pathB(VAULT_SIGNER, inner).cbor, ctx()).approval).toBe("unknown");
  });

  it("a batch nested in a batch is unknown", () => {
    const innerBatch = acct("vaultExecute", [[{ target: USDC, value: 0n, data: transfer(MALLORY, 1n) }], 0n]);
    const outer = acct("vaultExecute", [[{ target: ACCOUNT, value: 0n, data: innerBatch }], 0n]);
    const r = reviewRequestBytes(pathB(ACCOUNT, outer).cbor, ctx());
    expect(r.approval).toBe("unknown");
    expect(r.actions.some((a) => a.unknown?.reason === "Nested batch")).toBe(true);
  });

  it("an empty batch is unknown (nothing to show must not read as 'nothing happens')", () => {
    const r = reviewRequestBytes(pathB(ACCOUNT, acct("vaultExecute", [[], 0n])).cbor, ctx());
    expect(r.approval).toBe("unknown");
  });

  it("a known selector with calldata that does not decode is unknown", () => {
    const data = `${transfer(MALLORY, 1n).slice(0, 10)}00` as Hex; // selector + one byte
    const r = reviewRequestBytes(
      pathB(ACCOUNT, acct("vaultExecute", [[{ target: USDC, value: 0n, data }], 0n])).cbor,
      ctx(),
    );
    expect(r.approval).toBe("unknown");
  });

  it("the signer's own admin functions through executePQ get the admin banner", () => {
    const r = reviewRequestBytes(pathB(VAULT_SIGNER, signer("setPayerKey", [MALLORY])).cbor, ctx());
    expect(r.admin?.sentence).toMatch(/^Change this Vault's fee-payment key to 0x9999…9999/);
    expect(r.approval).toBe("normal");
  });

  it("a Vault request signed by the Recovery key's slot, and a sigIndex that points past the entries, are refused", () => {
    const b = usdcWithdrawal();
    rejects(() => reviewRequest({ ...b.request, sigIndex: 1 }, ctx()), "E-77");
    rejects(() => reviewRequest({ ...b.request, expectedPk: recovery.pk }, ctx()), "E-71");
  });
});

describe("value and recipient attacks (display must be the decoded truth)", () => {
  it("an ERC-20 call that also sends ETH says so in the headline", () => {
    const batch = acct("vaultExecute", [
      [{ target: USDC, value: 2n * 10n ** 18n, data: transfer(ALICE, 1_000_000n) }],
      0n,
    ]);
    const r = reviewRequestBytes(pathB(ACCOUNT, batch).cbor, ctx());
    expect(r.headline).toBe("Send 1 USDC to Alice (0xAb58…eC9B) and send 2 ETH");
  });

  it("a look-alike address (same first and last 4 characters) is a NEW RECIPIENT, never Alice", () => {
    const lookalike = getAddress(`${ALICE.slice(0, 6)}${"0".repeat(32)}${ALICE.slice(-4)}`);
    const r = reviewRequestBytes(usdcWithdrawal({ to: lookalike }).cbor, ctx());
    expect(r.actions[0]!.recipient).toMatchObject({ known: false });
    expect(r.actions[0]!.recipient!.name).toBeUndefined();
    expect(r.headline).not.toMatch(/Alice/);
    expect(r.actions[0]!.recipient!.address.toLowerCase()).toBe(lookalike.toLowerCase());
  });

  it("a token the phone does not know is shown in raw units: browser-reported decimals cannot shrink the amount", () => {
    const T: Address = "0x7777777777777777777777777777777777777777";
    const units = 1_000_000_000_000n; // 1,000,000 of a 6-decimal stablecoin
    const batch = acct("vaultExecute", [[{ target: T, value: 0n, data: transfer(MALLORY, units) }], 0n]);
    const policy: AdvisoryPolicy = {
      ...POLICY,
      tokens: [{ token: T.toLowerCase() as Hex, decimals: 18, usdPerToken: 1_000_000n }],
    };
    const r = reviewRequestBytes(pathB(ACCOUNT, batch, { policy }).cbor, ctx());
    const a = r.actions[0]!;
    expect(a.amount?.unknownToken).toBe(true);
    expect(a.amount?.text).toContain("1,000,000,000,000 units");
    expect(a.amount?.text).not.toContain("0.000001");
    expect(r.headline).toContain("1,000,000,000,000 units");
    // A USD estimate from the browser's price and decimals would be the same lie in dollars.
    expect(a.amount?.usd).toBeUndefined();
  });

  it("the same token, once this phone has signed its decimals, is formatted from the phone's snapshot", () => {
    const T: Address = "0x7777777777777777777777777777777777777777";
    const batch = acct("vaultExecute", [[{ target: T, value: 0n, data: transfer(MALLORY, 1_000_000_000_000n) }], 0n]);
    const snap = {
      account: ACCOUNT,
      chainId: 1337,
      signers: [],
      settings: {},
      tokens: { [T.toLowerCase()]: { allowed: true, decimals: 6, usdPerToken: 1_000_000n, signedAt: 1 } },
      updatedAt: 1,
    };
    const r = reviewRequestBytes(pathB(ACCOUNT, batch).cbor, ctx({ snapshots: [snap] }));
    expect(r.actions[0]!.amount).toEqual({
      text: "1,000,000 of token 0x7777…7777",
      usd: { text: "$1,000,000", source: "phone" },
      unknownToken: true,
    });
  });

  it("a browser that claims a higher current limit cannot make a raise read as 'lower'", () => {
    const setCap = acct("vaultSetCap", [200_000_000_000n, 20_000_000n, 2_000_000_000_000_000n, 4]); // $200,000
    const lying: AdvisoryPolicy = { ...POLICY, capUsdPerDay: 1_000_000_000_000n }; // "it is $1,000,000 now"
    const r = reviewRequestBytes(
      pathB(ACCOUNT, acct("vaultQueue", [[{ target: ACCOUNT, value: 0n, data: setCap }], 1]), { policy: lying }).cbor,
      ctx(),
    );
    expect(r.headline).toBe("Set daily limit to $200,000: takes effect after a 48-hour waiting period");
    expect(r.actions[0]!.details).toContainEqual({ label: "Daily limit", value: "$1,000,000 (browser) → $200,000" });
    expect(r.actions[0]!.loosening).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("browser-values");
  });

  it("with the phone's own snapshot the direction is computed from what this phone signed", () => {
    const setCap = acct("vaultSetCap", [200_000_000_000n, 20_000_000n, 2_000_000_000_000_000n, 4]);
    const snap = {
      account: ACCOUNT,
      chainId: 1337,
      signers: [],
      settings: { capUsdPerDay: 50_000_000n },
      tokens: {},
      updatedAt: 1,
    };
    const lying: AdvisoryPolicy = { ...POLICY, capUsdPerDay: 1_000_000_000_000n };
    const r = reviewRequestBytes(
      pathB(ACCOUNT, acct("vaultQueue", [[{ target: ACCOUNT, value: 0n, data: setCap }], 1]), { policy: lying }).cbor,
      ctx({ snapshots: [snap] }),
    );
    expect(r.headline).toMatch(/^Raise daily limit from \$50 → \$200,000/);
    expect(r.warnings.map((w) => w.code)).toContain("E-74");
  });

  it("once this phone has signed a limit itself, the next change reads from → to without a browser caveat", () => {
    const tighten = acct("vaultSetCap", [50_000_000n, 20_000_000n, 2_000_000_000_000_000n, 4]); // direct: instant
    const snaps = updateSnapshots(reviewRequestBytes(pathB(ACCOUNT, tighten).cbor, ctx()), [], 1);
    expect(snaps[0]!.settings.capUsdPerDay).toBe(50_000_000n);
    const raise = acct("vaultSetCap", [200_000_000n, 20_000_000n, 2_000_000_000_000_000n, 4]);
    const lying: AdvisoryPolicy = { ...POLICY, capUsdPerDay: 1_000_000_000_000n };
    const r = reviewRequestBytes(
      pathB(ACCOUNT, acct("vaultQueue", [[{ target: ACCOUNT, value: 0n, data: raise }], 1]), { policy: lying }).cbor,
      ctx({ snapshots: snaps }),
    );
    expect(r.headline).toBe("Raise daily limit from $50 → $200: takes effect after a 48-hour waiting period");
    expect(r.warnings.map((w) => w.code)).not.toContain("browser-values");
    expect(r.warnings.map((w) => w.code)).toContain("E-74"); // the lie is caught against what this phone signed
  });

  it("a browser description that names a different action is a mismatch (Approve anyway)", () => {
    const r = reviewRequestBytes(
      pathB(ACCOUNT, acct("vaultEnableBunker", []), {
        intent: { action: "send", recipient: ALICE.toLowerCase() as Hex, amount: 1n },
      }).cbor,
      ctx(),
    );
    expect(r.mismatch).toContain("action");
    expect(r.approval).toBe("anyway");
  });
});

describe("every admin entry point gets the admin banner", () => {
  const dummy = (p: AbiParameter): unknown => {
    if (p.type === "address") return ALICE;
    if (p.type === "bool") return true;
    if (p.type === "bytes32") return `0x${"ab".repeat(32)}`;
    if (p.type === "bytes4") return "0x12345678";
    if (p.type === "bytes") return "0x";
    if (p.type.endsWith("[]")) return [];
    if (p.type.startsWith("uint")) return 1n;
    throw new Error(`no dummy for ${p.type}`);
  };
  const abi = ACCOUNT_ABI.filter((i): i is AbiFunction => i.type === "function");
  for (const id of ACCOUNT_ADMIN_IDS) {
    const [abiName, fn] = id.split(".") as [string, string];
    if (abiName !== "account") continue;
    it(id, () => {
      const item = abi.find((i) => i.name === fn)!;
      const data = encodeFunctionData({
        abi: [item],
        functionName: fn as never,
        args: item.inputs.map(dummy) as never,
      });
      const isRecovery = fn.startsWith("recovery") && fn !== "recoveryFinalizeVaultRotation";
      if (isRecovery) {
        // Recovery-only entry points: a Vault must be refused outright (E-79), banner or not.
        rejects(() => reviewRequestBytes(pathB(ACCOUNT, data).cbor, ctx()), "E-79");
        return;
      }
      const r: Review = reviewRequestBytes(pathB(ACCOUNT, data).cbor, ctx());
      expect(r.unknown, r.headline).toBe(false);
      expect(r.admin, id).toBeDefined();
    });
  }
});

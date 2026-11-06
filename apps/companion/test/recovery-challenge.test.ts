import { SCHEME_ID, verify } from "@leaked/pq-signer";
import { decodeRecoveryTest, encodeRecoveryChallenge, fromHex, recoveryTestChallengeOf } from "@leaked/ur";
import { afterEach, describe, expect, it } from "vitest";
import { wordsToEntropy } from "../src/core/keys.js";
import { CHALLENGE_TTL_MS, ChallengeRefused, checkChallenge, readChallenge } from "../src/core/recoveryChallenge.js";
import { handle } from "../src/worker/handler.js";
import { RECOVERY_WORDS, recovery, vault } from "./fixtures/requests.js";

/** The browser-issued recovery test challenge (`ur:leaked-recovery-challenge`, extension M2). */

const REQUEST_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const challengeCbor = (pk = recovery.pk) => encodeRecoveryChallenge({ requestId: REQUEST_ID, recoveryPk: pk });
const noop = () => {};

afterEach(async () => {
  await handle({ op: "recoveryWipe" }, noop);
});

describe("recovery challenge", () => {
  it("reads the browser's request id and bounds it to 30 minutes from the scan", () => {
    const c = readChallenge(challengeCbor(), 1_000);
    expect(c).toEqual({
      requestId: REQUEST_ID,
      recoveryPk: recovery.pk,
      scannedAt: 1_000,
      expiresAt: 1_000 + CHALLENGE_TTL_MS,
    });
    expect(() => checkChallenge(c, recovery.pk, 1_000 + CHALLENGE_TTL_MS)).not.toThrow();
  });

  it("refuses an expired code and one for another key", () => {
    const c = readChallenge(challengeCbor(), 0);
    expect(() => checkChallenge(c, recovery.pk, CHALLENGE_TTL_MS + 1)).toThrow(ChallengeRefused);
    expect(() => checkChallenge(readChallenge(challengeCbor(vault.pk), 0), recovery.pk, 1)).toThrow(
      expect.objectContaining({ code: "E-71" }),
    );
  });

  it("the worker answers with a v2 test bound to the browser's request id (and the payer key 6)", async () => {
    await handle({ op: "recoveryLoad", entropy: wordsToEntropy(RECOVERY_WORDS), bip39Passphrase: "" }, noop);
    const c = readChallenge(challengeCbor(), Date.now());
    // The id signed is the scanned challenge's own: the UI cannot hand the worker a different one.
    const r = await handle(
      { op: "recoveryTest", challenge: { requestId: c.requestId, recoveryPk: c.recoveryPk, expiresAt: c.expiresAt } },
      noop,
    );
    if (r.op !== "recoveryTest") throw new Error("recoveryTest");
    const t = decodeRecoveryTest(r.cbor);
    expect(t.requestId).toBe(REQUEST_ID);
    expect(t.schemeId).toBe(SCHEME_ID);
    expect(t.payer).toBe(recovery.payer.toLowerCase());
    expect(verify(fromHex(t.recoveryPk), fromHex(recoveryTestChallengeOf(t)), fromHex(t.witness))).toBe(true);
  });

  it("the worker refuses an expired challenge and one naming another key", async () => {
    await handle({ op: "recoveryLoad", entropy: wordsToEntropy(RECOVERY_WORDS), bip39Passphrase: "" }, noop);
    await expect(
      handle(
        {
          op: "recoveryTest",
          challenge: { requestId: REQUEST_ID, recoveryPk: recovery.pk, expiresAt: Date.now() - 1 },
        },
        noop,
      ),
    ).rejects.toMatchObject({ code: "E-61" });
    await expect(
      handle(
        {
          op: "recoveryTest",
          challenge: { requestId: REQUEST_ID, recoveryPk: vault.pk, expiresAt: Date.now() + 60_000 },
        },
        noop,
      ),
    ).rejects.toMatchObject({ code: "E-71" });
    // Nothing was signed, and no test exists without a challenge: the request type has no other shape.
    // @ts-expect-error a phone-chosen id is not a request the worker accepts
    await expect(handle({ op: "recoveryTest", requestId: REQUEST_ID }, noop)).rejects.toThrow();
  });
});

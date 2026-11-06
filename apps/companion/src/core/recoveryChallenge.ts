import { decodeRecoveryChallenge, type Hex } from "@leaked/ur";
import { last8 } from "./format.js";

/**
 * The browser's `ur:leaked-recovery-challenge` (extension M2): the request id a recovery test must sign, chosen by the
 * browser and accepted once, within 30 minutes of when the browser showed it (`RECOVERY_CHALLENGE_TTL_MS` there). The
 * code carries no time, so this phone counts from when it scanned it. That is a bound at the latest (the scan comes
 * after the showing), so the phone's window is never shorter than the browser's; the browser's cutoff is the one that
 * counts, and a test signed after it is simply refused there. The check here is a courtesy, not the protection:
 * replay protection is the browser's single-use id.
 */
export const CHALLENGE_TTL_MS = 30 * 60_000;

export interface ScannedChallenge {
  requestId: string;
  recoveryPk: Hex;
  scannedAt: number;
  /** At the latest; the browser may stop accepting it earlier (it started counting when it showed the code). */
  expiresAt: number;
}

export class ChallengeRefused extends Error {
  constructor(
    readonly code: "E-71" | "E-61",
    readonly title: string,
    readonly body: string,
  ) {
    super(`${code}: ${title}`);
    this.name = "ChallengeRefused";
  }
}

export function readChallenge(cbor: Uint8Array, now: number): ScannedChallenge {
  const c = decodeRecoveryChallenge(cbor);
  return { requestId: c.requestId, recoveryPk: c.recoveryPk, scannedAt: now, expiresAt: now + CHALLENGE_TTL_MS };
}

/** The test may be answered only for the key the browser asked about, and only while the code is fresh. */
export function checkChallenge(c: Pick<ScannedChallenge, "recoveryPk" | "expiresAt">, pk: Hex, now: number): void {
  if (now > c.expiresAt) {
    throw new ChallengeRefused(
      "E-61",
      "This test code has expired.",
      "The browser accepts an answer for 30 minutes. Show a fresh test code in the browser and scan it again.",
    );
  }
  if (c.recoveryPk.toLowerCase() !== pk.toLowerCase()) {
    throw new ChallengeRefused(
      "E-71",
      "These words make a different Recovery key.",
      `The browser asked about the Recovery key ending …${last8(c.recoveryPk)}; these words make the one ending …${last8(pk)}. Check the paper, or scan the Recovery key code into the browser again.`,
    );
  }
}

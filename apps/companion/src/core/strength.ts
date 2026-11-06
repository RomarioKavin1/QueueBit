import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as en from "@zxcvbn-ts/language-en";

/**
 * Passphrase strength (backlog: "a strength check beyond 8 characters"): zxcvbn-ts (MIT, `@zxcvbn-ts/core` 4.2.0 with
 * the common and English dictionaries), loaded lazily by the passphrase screen so it does not slow down app start.
 * zxcvbn's score is 0–4 from an estimate of guesses against an attacker using common passwords, words, names, keyboard
 * patterns, dates and l33t. The passphrase guards a scrypt(N = 2^17) record (≈ 0.5 s per guess on a phone, far less
 * on a GPU rig), so:
 *  - score 0–1 ("weak", < 10^8 guesses): blocked;
 *  - score 2 ("fair", < 10^10): allowed with a warning;
 *  - score 3–4: fine.
 */

export type Strength = "weak" | "fair" | "strong";

export interface StrengthResult {
  strength: Strength;
  score: 0 | 1 | 2 | 3 | 4;
  /** zxcvbn's own one-line warning and suggestions (English), when it has them. */
  warning?: string;
  suggestions: string[];
}

const zxcvbn = new ZxcvbnFactory({
  dictionary: { ...common.dictionary, ...en.dictionary },
  graphs: common.adjacencyGraphs,
  translations: en.translations,
});

/** Words that make a passphrase easier to guess for this app in particular. */
const USER_INPUTS = ["leaked", "vault", "wallet", "recovery", "passphrase", "password", "ethereum", "crypto"];

export function checkStrength(passphrase: string, extra: string[] = []): StrengthResult {
  const r = zxcvbn.check(passphrase.slice(0, 256), [...USER_INPUTS, ...extra]);
  const score = r.score as StrengthResult["score"];
  return {
    strength: score <= 1 ? "weak" : score === 2 ? "fair" : "strong",
    score,
    ...(r.feedback.warning ? { warning: r.feedback.warning } : {}),
    suggestions: r.feedback.suggestions,
  };
}

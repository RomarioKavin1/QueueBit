import { describe, expect, it } from "vitest";
import { checkStrength } from "../src/core/strength.js";

describe("passphrase strength (zxcvbn-ts)", () => {
  it("blocks common and patterned passphrases", () => {
    for (const p of ["password1", "qwertyuiop", "12345678", "leakedvault", "iloveyou2026"])
      expect(checkStrength(p).strength, p).toBe("weak");
  });
  it("lets random multi-word and long mixed passphrases through", () => {
    expect(checkStrength("orbit crayon velvet tundra").strength).toBe("strong");
    expect(checkStrength("k7#Vq!2mZr9@pLx").strength).toBe("strong");
  });
  it("gives a reason for a weak one", () => {
    const r = checkStrength("password1");
    expect(r.score).toBeLessThanOrEqual(1);
    expect((r.warning ?? r.suggestions[0] ?? "").length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { decodeTx, encodeTx, profiles, sigHash, txHash, type Profile } from "../src/index.js";
import { samples } from "./samples.js";
import { vectors as current } from "./vectors/eip8141-current.js";
import { vectors as tracer } from "./vectors/ethrex-eip8141-tracer.js";
import { vectors as hegota } from "./vectors/ethrex-hegota-devnet.js";

// A frozen profile must keep producing exactly these bytes. If this fails after editing a profile or the codec, a
// network that runs the old rules would break: add a new profile instead.
// The two ethrex vector sets were pinned by @forshtat/hegota-support's own codec; reproducing them is the
// cross-check of the port.
type Vector = { readonly name: string; readonly raw: string; readonly sigHash: string; readonly txHash: string };
const pinned: Record<string, readonly Vector[]> = {
  "ethrex-eip8141-tracer": tracer,
  "ethrex-hegota-devnet": hegota,
  "eip8141-current": current,
};

it("every profile has pinned vectors", () => {
  expect(Object.keys(pinned).sort()).toEqual(Object.keys(profiles).sort());
});

for (const profile of Object.values(profiles) as Profile[]) {
  describe(`pinned vectors: ${profile.id}`, async () => {
    const vectors = pinned[profile.id]!;
    const current = await samples(profile);

    it("covers every sample", () => {
      expect(vectors.map((v) => v.name)).toEqual(current.map((s) => s.name));
    });

    for (const [i, v] of vectors.entries()) {
      it(v.name, () => {
        const tx = current[i]!.tx;
        expect(encodeTx(profile, tx)).toBe(v.raw);
        expect(sigHash(profile, tx)).toBe(v.sigHash);
        expect(txHash(profile, tx)).toBe(v.txHash);
        const back = decodeTx(profile, v.raw as `0x${string}`);
        expect(encodeTx(profile, back)).toBe(v.raw);
        expect(sigHash(profile, back)).toBe(v.sigHash);
        expect(txHash(profile, back)).toBe(v.txHash);
      });
    }
  });
}

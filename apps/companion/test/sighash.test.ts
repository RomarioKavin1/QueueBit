import { getProfile, sigHash } from "@leaked/frames";
import { describe, expect, it } from "vitest";
import { vectors as current } from "../../../packages/frames/test/vectors/eip8141-current.js";
import { vectors as tracer } from "../../../packages/frames/test/vectors/ethrex-eip8141-tracer.js";
import { vectors as hegota } from "../../../packages/frames/test/vectors/ethrex-hegota-devnet.js";
import { frameDigest } from "../src/core/clearsign.js";
import { PROFILE_ID, limitRaise, usdcWithdrawal } from "./fixtures/requests.js";

// The companion recomputes the sig hash from the request bytes. These are the pinned @leaked/frames vectors (two of
// the three sets are copied verbatim from hegota-support, i.e. independent of our codec): the companion's digest path
// must reproduce every one of them.
const sets = { "eip8141-current": current, "ethrex-eip8141-tracer": tracer, "ethrex-hegota-devnet": hegota } as const;

describe("sig hash recomputation matches the @leaked/frames vectors", () => {
  for (const [id, vs] of Object.entries(sets)) {
    for (const v of vs) {
      it(`${id}: ${v.name}`, () => {
        const { digest } = frameDigest(getProfile(id), v.raw as `0x${string}`);
        expect(digest).toBe(v.sigHash);
      });
    }
  }

  it("on a role-signer request, equals sigHash of the builder's transaction (placeholder elided)", () => {
    for (const b of [limitRaise(), usdcWithdrawal()]) {
      const p = getProfile(PROFILE_ID);
      expect(frameDigest(p, b.request.payload).digest).toBe(sigHash(p, b.tx));
    }
  });

  it("pins one request digest (regression)", () => {
    expect(usdcWithdrawal().digest).toMatchInlineSnapshot(
      `"0xbbe0bf83b0976dc02570c29520e422b6248e7a530c90b88feb050694543868be"`,
    );
  });
});

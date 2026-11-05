// From @forshtat/hegota-support (MIT, Copyright (c) 2026 Alex Forshtat), src/tx/recentRoots.ts at 2377188.
// See THIRD_PARTY.md.
import { concat, numberToHex, type Hex } from "viem";
import type { RecentRootReference } from "./types.js";

export const RECENT_ROOT_TUPLE_BYTES = 72;
export const MAX_RECENT_ROOT_REFERENCES = 16;

/**
 * The data of a VERIFY frame that targets `RECENT_ROOT_ADDRESS`, per the current EIP-8272 text: 1 to 16 concatenated
 * 72-byte tuples `source_id (32) || slot (8, big-endian) || root (32)`, with no selector or length prefix.
 *
 * This is the *current* EIP's way of carrying recent roots. Devnets on the early revision carry them in a payload
 * field instead (`FrameTx.recentRootReferences`, see the profile's `envelope`).
 */
export function encodeRecentRootData(refs: readonly RecentRootReference[]): Hex {
  if (refs.length < 1 || refs.length > MAX_RECENT_ROOT_REFERENCES) {
    throw new Error(`EIP-8272 takes 1 to ${MAX_RECENT_ROOT_REFERENCES} references, got ${refs.length}`);
  }
  return concat(
    refs.map((r) => {
      if (r.sourceId.length !== 66 || r.root.length !== 66) throw new Error("source_id and root must be 32 bytes");
      if (r.slot < 0n || r.slot >= 2n ** 64n) throw new Error("slot must fit in a uint64");
      return concat([r.sourceId, numberToHex(r.slot, { size: 8 }), r.root]);
    }),
  );
}

// Adapted from @forshtat/hegota-support (MIT, Copyright (c) 2026 Alex Forshtat), test/samples.ts at 2377188.
// The first four samples are unchanged, so the hegota-support vectors still apply; profiles with a total fee budget
// (eip8141-current) get `maxFee` instead of a per-gas cap and skip the keyed-nonce sample they cannot carry.
// See THIRD_PARTY.md.
import { privateKeyToAccount } from "viem/accounts";
import {
  arbitraryEntry,
  frame,
  newTx,
  secp256k1Placeholder,
  setSignature,
  signTx,
  type FrameTx,
  type Profile,
  type TxInit,
} from "../src/index.js";

export const KEY = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
export const OWNER = privateKeyToAccount(KEY).address;
export const RECIPIENT = "0x8943545177806ED17B9F23F0a21ee5948eCaa776" as const;
export const WALLET = "0x00000000000000000000000000000000000000b1" as const;

const budget = (p: Profile) => p.envelope.includes("feeBudget");

/** Per-gas fees on devnet profiles; a total budget of `gas * maxFeePerGas` on budget profiles. */
function fees(p: Profile, maxFeePerGas: bigint, maxPriorityFeePerGas?: bigint): TxInit["fees"] {
  if (!budget(p)) {
    return maxPriorityFeePerGas === undefined ? { maxFeePerGas } : { maxFeePerGas, maxPriorityFeePerGas };
  }
  return { maxFee: maxFeePerGas * 1_000_000n, maxPriorityFeePerGas: maxPriorityFeePerGas ?? maxFeePerGas };
}

/** The sample transactions every profile is pinned against. Deterministic: fixed key, fixed fields. */
export async function samples(profile: Profile): Promise<{ name: string; tx: FrameTx }[]> {
  const chainId = profile.devnet.chainId ?? 1;
  const out: { name: string; tx: FrameTx }[] = [];

  out.push({
    name: "self-relay",
    tx: await signTx(
      profile,
      newTx({
        chainId,
        sender: OWNER,
        nonceSeq: 7n,
        fees: fees(profile, 2_000_000_000n),
        signatures: [secp256k1Placeholder(profile)],
        frames: [
          frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 30_000n }),
          frame(profile, "SENDER", { target: RECIPIENT, execution: 50_000n, state: 200_000n, value: 1_000_000_000n }),
        ],
      }),
      KEY,
    ),
  });

  out.push({
    name: "wallet with explicit signer and verify data",
    tx: await signTx(
      profile,
      newTx({
        chainId,
        sender: WALLET,
        nonceSeq: 1n,
        fees: fees(profile, 3_000_000_000n, 1_000_000_000n),
        signatures: [secp256k1Placeholder(profile, OWNER)],
        frames: [
          frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 70_000n, data: "0x01" }),
          frame(profile, "SENDER", { target: RECIPIENT, execution: 50_000n, state: 200_000n, value: 5n }),
        ],
      }),
      KEY,
    ),
  });

  if (profile.envelope.includes("nonceKeys") && profile.envelope.includes("recentRootReferences")) {
    out.push({
      name: "keyed nonces and a recent-root reference",
      tx: await signTx(
        profile,
        {
          ...newTx({
            chainId,
            sender: OWNER,
            nonceKeys: [1n, 2n],
            nonceSeq: 0n,
            fees: fees(profile, 2_000_000_000n),
            signatures: [secp256k1Placeholder(profile)],
            frames: [frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 30_000n })],
          }),
          recentRootReferences: [{ sourceId: `0x${"11".repeat(32)}`, slot: 1234n, root: `0x${"22".repeat(32)}` }],
        },
        KEY,
      ),
    });
  }

  if (profile.frameModes.POST_TX !== undefined) {
    out.push({
      name: "post-tx assertion",
      tx: await signTx(
        profile,
        newTx({
          chainId,
          sender: OWNER,
          nonceSeq: 3n,
          fees: fees(profile, 3_000_000_000n, 1_000_000_000n),
          signatures: [secp256k1Placeholder(profile)],
          frames: [
            frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 30_000n }),
            frame(profile, "SENDER", { target: RECIPIENT, execution: 200_000n, value: 1n }),
            frame(profile, "POST_TX", { target: WALLET, execution: 300_000n, data: "0x1234" }),
          ],
        }),
        KEY,
      ),
    });
  }

  if (budget(profile)) {
    // Only on profiles pinned by @queuebit/frames: a fixed-length ARBITRARY witness next to a SECP256K1 payer, the
    // shape of a Path-B vault transaction. The witness is filled after the payer signed: the sig hash commits only
    // to its length.
    const unsigned = newTx({
      chainId,
      sender: WALLET,
      nonceSeq: 9n,
      fees: fees(profile, 1_000_000_000n, 100_000_000n),
      signatures: [arbitraryEntry(profile, 40), secp256k1Placeholder(profile, OWNER)],
      frames: [
        frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 400_000n, data: "0x4b7ad6c2" }),
        frame(profile, "SENDER", { target: WALLET, execution: 600_000n, data: "0xabcdef" }),
      ],
    });
    const signed = await signTx(profile, unsigned, KEY, 1);
    out.push({
      name: "fixed-length witness and a payer",
      tx: setSignature(profile, signed, 0, `0x${"5a".repeat(40)}`),
    });
  }

  return out;
}

/** The first sample (a plain self-relay), for tests that need one transaction. */
export async function firstSample(profile: Profile): Promise<FrameTx> {
  const [first] = await samples(profile);
  if (!first) throw new Error("no samples");
  return first.tx;
}

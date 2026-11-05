import { getProfile, recoverSecp256k1Signer, setSignature } from "@leaked/frames";
import { SCHEME_ID, verify } from "@leaked/pq-signer";
import { AnimatedUr, UR_TYPES, UrReceiver, fromHex, recoveryTestChallenge, type DecodedUr } from "@leaked/ur";
import { PROFILE_ID, type Built } from "../fixtures/requests.js";

/**
 * Node-side helpers for the Playwright suite, loaded through Vite's module runner (e2e/support.ts) so they can use the
 * workspace packages' TypeScript sources. They play the extension's part: make request codes, check what comes back.
 */

export * from "../fixtures/requests.js";

/** The request as the extension's "Copy as text": every pure part, one per line. */
export function requestText(cbor: Uint8Array, maxFragmentLength = 400): string {
  const enc = new AnimatedUr(UR_TYPES.signRequest, cbor, { maxFragmentLength });
  return enc.parts(enc.partCount).join("\n");
}

export function decodeParts(text: string, type: (typeof UR_TYPES)[keyof typeof UR_TYPES]): DecodedUr {
  const rx = new UrReceiver([type]);
  for (const line of text.split(/\s+/)) {
    if (!line) continue;
    const r = rx.receive(line);
    if (r.status === "complete") return r.decoded;
    if (r.status === "error") throw r.error;
  }
  throw new Error("incomplete UR");
}

/** What the extension does with `ur:leaked-signature` (plan §30 §6.2): verify the witness and, on Path B, the payer. */
export async function checkSignature(text: string, built: Built, pk: `0x${string}`, payer?: `0x${string}`) {
  const d = decodeParts(text, UR_TYPES.signature);
  if (d.type !== UR_TYPES.signature) throw new Error("not a signature");
  const s = d.value;
  const witnessOk = !!s.witness && verify(fromHex(pk), fromHex(built.digest), fromHex(s.witness));
  let payerOk: boolean | undefined;
  if (s.payerSig) {
    const p = getProfile(PROFILE_ID);
    const signed = setSignature(p, setSignature(p, built.tx, 0, s.witness!), 1, s.payerSig);
    payerOk = (await recoverSecp256k1Signer(p, signed, 1)).toLowerCase() === payer?.toLowerCase();
  }
  return {
    requestId: s.requestId,
    schemeOk: s.schemeId === SCHEME_ID,
    witnessLength: s.witness ? (s.witness.length - 2) / 2 : 0,
    witnessOk,
    payerOk,
  };
}

export function checkPairing(text: string) {
  const d = decodeParts(text, UR_TYPES.pqKey);
  if (d.type !== UR_TYPES.pqKey) throw new Error("not a pairing code");
  return d.value;
}

export function checkRecoveryTest(text: string) {
  const d = decodeParts(text, UR_TYPES.recoveryTest);
  if (d.type !== UR_TYPES.recoveryTest) throw new Error("not a recovery test");
  const t = d.value;
  return {
    pk: t.recoveryPk,
    ok: verify(
      fromHex(t.recoveryPk),
      fromHex(recoveryTestChallenge(SCHEME_ID, t.recoveryPk, t.requestId)),
      fromHex(t.witness),
    ),
  };
}

// WebAuthn helpers shared by the SDK and the test-vector generator.
// The browser path (navigator.credentials.get) produces the same three pieces; this module builds and checks them.
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concat, encodeAbiParameters, hexToBytes, toHex } from "viem";
import type { Hex } from "viem";

export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface Assertion {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: bigint;
  s: bigint;
}

const N = p256.CURVE.n;

/** Low-s form: P256VERIFY accepts both; we normalise so a signature has one encoding. */
export const lowS = (s: bigint) => (s > N / 2n ? N - s : s);

/** The pieces an authenticator signs, for a challenge (the frame tx's SIG_HASH). */
export function clientData(challenge: Hex, origin: string) {
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(hexToBytes(challenge)), origin, crossOrigin: false });
  return {
    clientDataJSON,
    challengeIndex: BigInt(clientDataJSON.indexOf('"challenge":"')),
    typeIndex: BigInt(clientDataJSON.indexOf('"type":"webauthn.get"')),
  };
}

/** authenticatorData = rpIdHash ‖ flags ‖ signCount. Flags 0x05 = user present + user verified. */
export function authenticatorData(rpId: string, flags = 0x05, signCount = 1): Hex {
  return concat([toHex(sha256(new TextEncoder().encode(rpId))), toHex(flags, { size: 1 }), toHex(signCount, { size: 4 })]);
}

export const digestOf = (authData: Hex, clientDataJSON: string) =>
  sha256(new Uint8Array([...hexToBytes(authData), ...sha256(new TextEncoder().encode(clientDataJSON))]));

/** A software authenticator (tests, scripts): signs exactly what a browser passkey signs. */
export function softSign(privateKey: Uint8Array, challenge: Hex, rpId: string, origin: string, flags = 0x05): Assertion {
  const cd = clientData(challenge, origin);
  const ad = authenticatorData(rpId, flags);
  const sig = p256.sign(digestOf(ad, cd.clientDataJSON), privateKey, { lowS: true, prehash: false });
  return { authenticatorData: ad, clientDataJSON: cd.clientDataJSON, challengeIndex: cd.challengeIndex, typeIndex: cd.typeIndex, r: sig.r, s: sig.s };
}

export function publicKeyXY(privateKey: Uint8Array): { x: Hex; y: Hex } {
  const pub = p256.getPublicKey(privateKey, false);
  return { x: bytesToHex(pub.slice(1, 33)), y: bytesToHex(pub.slice(33, 65)) };
}

/** The ARBITRARY entry bytes the keystore decodes: abi.encode(keyId, Assertion). */
export function encodeAssertion(keyId: Hex, a: Assertion): Hex {
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "tuple", components: [
      { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
      { name: "challengeIndex", type: "uint256" }, { name: "typeIndex", type: "uint256" }, { name: "r", type: "uint256" }, { name: "s", type: "uint256" } ] }],
    [keyId, a],
  );
}

import { bytesToHex, encodeAbiParameters, type Hex } from "viem";

/** A WebAuthn assertion as the keystore verifies it (WebAuthn.sol): the authenticator signed
 * sha256(authenticatorData ‖ sha256(clientDataJSON)), and clientDataJSON's challenge is the tx's sig hash. */
export interface Assertion {
  authenticatorData: Hex;
  clientDataJSON: string;
  /** Offset of `"challenge":"` in clientDataJSON. */
  challengeIndex: bigint;
  /** Offset of `"type":"webauthn.get"` in clientDataJSON. */
  typeIndex: bigint;
  r: bigint;
  s: bigint;
}

/** The P-256 group order. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Low-s form: P256VERIFY accepts both, the keystore normalises so a signature has one encoding. */
export const lowS = (s: bigint): bigint => (s > N / 2n ? N - s : s);

/** The ARBITRARY entry bytes the keystore decodes: abi.encode(keyId, Assertion). */
export function encodeAssertion(keyId: Hex, a: Assertion): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      {
        type: "tuple",
        components: [
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "string" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "r", type: "uint256" },
          { name: "s", type: "uint256" },
        ],
      },
    ],
    [keyId, { ...a, s: lowS(a.s) }],
  );
}

/** r, s from a DER-encoded ECDSA signature (what `navigator.credentials.get` returns). */
export function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (b: number) => {
    if (der[i++] !== b) throw new Error("not a DER ECDSA signature");
  };
  const int = (): bigint => {
    expect(0x02);
    const len = der[i++]!;
    const v = der.slice(i, i + len);
    i += len;
    return BigInt(bytesToHex(v));
  };
  expect(0x30);
  i++; // sequence length
  const r = int();
  const s = int();
  return { r, s };
}

/** An Assertion from a browser credential response (`AuthenticatorAssertionResponse`). */
export function assertionFromResponse(resp: {
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
}): Assertion {
  const clientDataJSON = new TextDecoder().decode(resp.clientDataJSON);
  const { r, s } = derToRS(new Uint8Array(resp.signature));
  return {
    authenticatorData: bytesToHex(new Uint8Array(resp.authenticatorData)),
    clientDataJSON,
    challengeIndex: BigInt(clientDataJSON.indexOf('"challenge":"')),
    typeIndex: BigInt(clientDataJSON.indexOf('"type":"webauthn.get"')),
    r,
    s,
  };
}

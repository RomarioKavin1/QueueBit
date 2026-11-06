import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { p256 } from "@noble/curves/p256";
import { keccak256, toHex } from "viem";
import { ROOT } from "../../core/config.ts";
import { softSign, publicKeyXY, digestOf } from "../webauthn.ts";

test("a WebAuthn assertion verifies like a browser passkey's, and writes the Forge vector", () => {
  const sk = p256.utils.randomPrivateKey();
  const challenge = keccak256(toHex("a frame tx SIG_HASH"));
  const a = softSign(sk, challenge, "127.0.0.1", "http://127.0.0.1:8787");
  const { x, y } = publicKeyXY(sk);
  const pub = p256.getPublicKey(sk, false);
  expect(p256.verify({ r: a.r, s: a.s }, digestOf(a.authenticatorData, a.clientDataJSON), pub, { prehash: false })).toBe(true);
  expect(a.clientDataJSON.slice(Number(a.typeIndex), Number(a.typeIndex) + 21)).toBe('"type":"webauthn.get"');
  fs.writeFileSync(path.join(ROOT, "../../test/account/fixtures/webauthn-vector.json"), JSON.stringify({
    challenge, x, y, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON,
    challengeIndex: Number(a.challengeIndex), typeIndex: Number(a.typeIndex), r: toHex(a.r, { size: 32 }), s: toHex(a.s, { size: 32 }),
  }, null, 2));
});

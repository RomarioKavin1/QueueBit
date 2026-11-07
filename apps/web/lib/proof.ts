import type { SignProof } from "@queuebit/extension/src/shared/messages";
import { engine } from "./engine/client";
import { passkeySecret } from "./passkey";

/**
 * The proof a signing request carries: the engine (built with `confirmEachSignature`) refuses to sign without the
 * passkey's secret or the password again, even while the wallet is unlocked. A passkey wallet asks the passkey here.
 */
export async function passkeyProof(): Promise<SignProof> {
  const info = await engine().call("keyring:passkeyInfo");
  if (!info) throw new Error("This wallet has no passkey.");
  const { entropy } = await passkeySecret(navigator.credentials, info.credentialId);
  return { entropy };
}

/** Asks the passkey, or uses the typed password; checks it with the engine before anything is signed. */
export async function signProof(lockedWith: "passkey" | "password", password?: string): Promise<SignProof> {
  const proof: SignProof = lockedWith === "passkey" ? await passkeyProof() : { password: password ?? "" };
  await engine().call("keyring:verify", proof);
  return proof;
}

export type { SignProof };

import { describe, expect, it } from "vitest";
import { PASSKEY_PRF_SALT } from "@queuebit/extension/src/background/keyring";
import { PasskeyError, createPasskey, passkeySecret } from "../lib/passkey";

const RAW_ID = new Uint8Array([1, 2, 3, 250]);
const RAW_ID_B64URL = "AQID-g"; // base64url of RAW_ID
const PRF = new Uint8Array(32).fill(0x7f);
const PRF_HEX = `0x${"7f".repeat(32)}`;

type Ext = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
const credential = (ext: Ext) => ({ rawId: RAW_ID.buffer.slice(0), getClientExtensionResults: () => ext });

/** A fake navigator.credentials that records what it was asked. */
function fakeCreds(o: { create?: Ext; get?: Ext; fail?: Error }) {
  const calls: { create: CredentialCreationOptions[]; get: CredentialRequestOptions[] } = { create: [], get: [] };
  return {
    calls,
    creds: {
      create: async (opts: CredentialCreationOptions) => {
        calls.create.push(opts);
        if (o.fail) throw o.fail;
        return credential(o.create ?? {});
      },
      get: async (opts: CredentialRequestOptions) => {
        calls.get.push(opts);
        if (o.fail) throw o.fail;
        return credential(o.get ?? {});
      },
    } as unknown as CredentialsContainer,
  };
}

const prfIn = (opts: { publicKey?: { extensions?: unknown } }) =>
  new Uint8Array((opts.publicKey?.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first);

describe("createPasskey", () => {
  it("returns the credential id and the PRF output when create already evaluates PRF", async () => {
    const { creds, calls } = fakeCreds({ create: { prf: { enabled: true, results: { first: PRF.buffer.slice(0) } } } });
    expect(await createPasskey(creds, { userName: "alice" })).toEqual({
      credentialId: RAW_ID_B64URL,
      entropy: PRF_HEX,
    });
    expect(prfIn(calls.create[0]!)).toEqual(PASSKEY_PRF_SALT);
    expect(calls.get).toHaveLength(0);
  });

  it("asks the new passkey once more when create only reports PRF as enabled", async () => {
    const { creds, calls } = fakeCreds({
      create: { prf: { enabled: true } },
      get: { prf: { results: { first: PRF.buffer.slice(0) } } },
    });
    expect(await createPasskey(creds, { userName: "alice" })).toEqual({
      credentialId: RAW_ID_B64URL,
      entropy: PRF_HEX,
    });
    expect(calls.get).toHaveLength(1);
    expect(prfIn(calls.get[0]!)).toEqual(PASSKEY_PRF_SALT);
  });

  it("refuses an authenticator without PRF", async () => {
    const { creds } = fakeCreds({ create: { prf: { enabled: false } } });
    await expect(createPasskey(creds, { userName: "alice" })).rejects.toMatchObject({ reason: "no-prf" });
  });

  it("reports a cancelled prompt", async () => {
    const { creds } = fakeCreds({
      fail: new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"),
    });
    await expect(createPasskey(creds, { userName: "alice" })).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("reports a browser without WebAuthn", async () => {
    await expect(createPasskey(undefined, { userName: "alice" })).rejects.toBeInstanceOf(PasskeyError);
    await expect(createPasskey(undefined, { userName: "alice" })).rejects.toMatchObject({ reason: "unsupported" });
  });
});

describe("passkeySecret", () => {
  it("asks for the given passkey and returns its PRF output", async () => {
    const { creds, calls } = fakeCreds({ get: { prf: { results: { first: PRF.buffer.slice(0) } } } });
    expect(await passkeySecret(creds, RAW_ID_B64URL)).toEqual({ credentialId: RAW_ID_B64URL, entropy: PRF_HEX });
    const allow = calls.get[0]!.publicKey!.allowCredentials!;
    expect(allow).toHaveLength(1);
    expect(new Uint8Array(allow[0]!.id as ArrayBuffer)).toEqual(RAW_ID);
  });

  it("refuses a passkey that returns no PRF output", async () => {
    const { creds } = fakeCreds({ get: {} });
    await expect(passkeySecret(creds, RAW_ID_B64URL)).rejects.toMatchObject({ reason: "no-prf" });
  });
});

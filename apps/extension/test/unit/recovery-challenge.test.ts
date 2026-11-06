import { hexToBytes, toHex, type Hex } from "viem";
import { SCHEME_ID, keygen, sign } from "@queuebit/pq-signer";
import {
  AnimatedUr,
  UR_TYPES,
  UrReceiver,
  encodeRecoveryTest,
  randomUuid,
  recoveryTestChallenge,
  type RecoveryChallenge,
} from "@queuebit/ur";
import { beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "../../src/background/wallet";
import { MemoryKV } from "../../src/shared/kv";

/**
 * The recovery test's request id is chosen by the browser (a single-use challenge shown as
 * `ur:queuebit-recovery-challenge`), and the v2 test's payer address becomes `InitConfig.recovery.payerKey`.
 */

const rec = keygen(new Uint8Array(64).fill(0x22), { role: "recovery" });
const PK = toHex(rec.publicKey);
const PAYER = "0x00000000000000000000000000000000000000fb" as Hex;
let t = 1_700_000_000_000;

function wallet() {
  return new Wallet({
    local: new MemoryKV(),
    session: new MemoryKV(),
    windows: { open: async () => 1, focus: async () => true, exists: async () => true },
    readRpc: async () => null,
    getBalance: async () => 0n,
    emit: () => undefined,
    keyring: { scrypt: { N: 2 ** 10, r: 8, p: 1 } },
    now: () => t,
  });
}

const parts = (cbor: Uint8Array) => {
  const a = new AnimatedUr(UR_TYPES.recoveryTest, cbor);
  return a.parts(a.partCount).join("\n");
};

/** What the phone does: sign the v2 challenge over the browser's request id. */
function phoneTest(requestId: string): string {
  const witness = toHex(sign(rec.secretKey, hexToBytes(recoveryTestChallenge(SCHEME_ID, PK, requestId, PAYER))));
  return parts(encodeRecoveryTest({ requestId, schemeId: SCHEME_ID, recoveryPk: PK, witness, ok: true, payer: PAYER }));
}

function readChallenge(text: string): RecoveryChallenge {
  const r = new UrReceiver([UR_TYPES.recoveryChallenge]).receive(text);
  if (r.status !== "complete") throw new Error("challenge");
  return r.decoded.value as RecoveryChallenge;
}

let w: Wallet;
beforeAll(async () => {
  w = wallet();
  await w.keyring.create("password-1");
}, 60_000);

describe("recovery test challenge", () => {
  it("refuses a test the phone made with its own request id (replay protection)", async () => {
    await w.settings.setPaired("recovery", { schemeId: SCHEME_ID, pk: PK, at: t });
    await w.handleUi("pair:recoveryChallenge", undefined);
    await expect(w.handleUi("pair:recoveryTest", { text: phoneTest(randomUuid()) })).rejects.toMatchObject({
      code: "E-61",
    });
  }, 60_000);

  it("accepts the answer to the challenge once, records the signed payer, and consumes the challenge", async () => {
    const { text, requestId } = await w.handleUi("pair:recoveryChallenge", undefined);
    const ch = readChallenge(text);
    expect(ch).toEqual({ requestId, recoveryPk: PK });
    const answer = phoneTest(ch.requestId);
    const ok = await w.handleUi("pair:recoveryTest", { text: answer });
    expect(ok).toMatchObject({ ok: true, payer: PAYER });
    const setup = await w.settings.getSetup();
    expect(setup.recovery).toMatchObject({ pk: PK, payer: PAYER });
    expect(setup.recovery?.testedAt).toBe(t);
    expect(setup.recoveryChallenge).toBeUndefined();
    // The same code again: the challenge is gone.
    await expect(w.handleUi("pair:recoveryTest", { text: answer })).rejects.toMatchObject({ code: "E-61" });
  }, 60_000);

  it("a challenge expires after 30 minutes", async () => {
    const { requestId } = await w.handleUi("pair:recoveryChallenge", undefined);
    t += 31 * 60_000;
    await expect(w.handleUi("pair:recoveryTest", { text: phoneTest(requestId) })).rejects.toMatchObject({
      code: "E-61",
    });
  }, 60_000);

  it("refuses a Recovery payer that is one of this browser's keys", async () => {
    const accounts = (await w.keyring.accounts())!;
    const { requestId } = await w.handleUi("pair:recoveryChallenge", undefined);
    const witness = toHex(
      sign(
        rec.secretKey,
        hexToBytes(recoveryTestChallenge(SCHEME_ID, PK, requestId, accounts.feeTank.toLowerCase() as Hex)),
      ),
    );
    const text = parts(
      encodeRecoveryTest({
        requestId,
        schemeId: SCHEME_ID,
        recoveryPk: PK,
        witness,
        ok: true,
        payer: accounts.feeTank.toLowerCase() as Hex,
      }),
    );
    await expect(w.handleUi("pair:recoveryTest", { text })).rejects.toMatchObject({ code: "E-23" });
  }, 60_000);
});

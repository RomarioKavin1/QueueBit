import { parseManualCode, type Channel } from "@queuebit/relay-client";
import { useEffect, useRef, useState } from "react";
import { useNav, useStore } from "../app/state.js";
import type { VaultRecord } from "../core/db.js";
import { last8 } from "../core/format.js";
import { pairWords, relayAvailable, relayClient, sendPairing } from "../core/relay.js";
import { CheckIcon, VaultIcon } from "../ui/icons.js";
import { Banner, Button, Card, Screen, Spinner, TextField } from "../ui/kit.js";
import { StaticQr } from "../ui/qr.js";
import { pairingUr } from "./Onboarding.js";

/**
 * "Link to browser" (onboarding v2): the phone opened the browser's QR link (`#pair=<id>.<key>`). With no Vault yet the
 * user creates one first; with one, a single tap sends its pairing code to the browser over the relay, and both
 * screens show the same 4 words.
 */
export function LinkScreen({ channel }: { channel: Channel }) {
  const nav = useNav();
  const store = useStore();
  if (!store.vault)
    return (
      <Screen title="Link to your browser" onBack={() => nav.reset({ name: "welcome" })}>
        <div className="flex flex-col items-center gap-3 pt-4 text-center">
          <span className="inline-flex h-16 w-16 items-center justify-center rounded-lg bg-vault-bg text-vault">
            <VaultIcon size={36} />
          </span>
          <p className="max-w-[32ch] t-body">
            This phone will approve your bigger payments. First, make its key: it takes about a minute.
          </p>
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <Button
            variant="vault"
            big
            onClick={() => nav.push({ name: "create", link: channel })}
            data-testid="link-create"
          >
            Create my Vault key
          </Button>
          <Button variant="secondary" onClick={() => nav.push({ name: "restore" })}>
            I have 24 words already
          </Button>
        </div>
      </Screen>
    );
  return (
    <LinkSend
      channel={channel}
      vault={store.vault}
      onDone={() => nav.reset({ name: "home" })}
      onBack={() => nav.reset({ name: "home" })}
    />
  );
}

type Phase = { s: "ask" } | { s: "sending" } | { s: "sent"; words: string[] } | { s: "error"; message: string };

/** Sends this Vault's pairing code over the relay (at once with `auto`), then shows the 4-word check. */
export function LinkSend({
  channel,
  vault,
  onDone,
  onBack,
  auto,
  doneLabel = "Done",
}: {
  channel: Channel;
  vault: VaultRecord;
  onDone: () => void;
  onBack?: () => void;
  auto?: boolean;
  doneLabel?: string;
}) {
  const store = useStore();
  const [phase, setPhase] = useState<Phase>({ s: auto ? "sending" : "ask" });
  const started = useRef(false);
  const online = relayAvailable(store.settings);
  const ur = pairingUr(vault.vaultPk, vault.payerAddress, vault.schemeId);

  const send = async () => {
    setPhase({ s: "sending" });
    try {
      await store.saveLinks(await sendPairing(relayClient(), channel, ur, store.links));
      setPhase({ s: "sent", words: pairWords(vault.vaultPk, vault.payerAddress) });
    } catch (e) {
      setPhase({ s: "error", message: (e as Error).message });
    }
  };
  useEffect(() => {
    if (auto && online && !started.current) {
      started.current = true;
      void send();
    }
  }, [auto, online]);

  if (!online)
    return (
      <Screen title="Link to your browser" {...(onBack ? { onBack } : {})}>
        <Banner level="info" title="This phone is set to offline">
          In the browser, choose “Can&apos;t scan? Use the manual code”, then show it this code or paste the text below.
        </Banner>
        <StaticQr text={ur} label="Vault pairing code for the browser" />
        <textarea
          readOnly
          rows={3}
          className="t-mono w-full rounded-md border border-line bg-surface p-2 text-[11px]"
          value={ur}
          aria-label="Pairing code as text"
          data-testid="link-offline-code"
        />
        <Button onClick={onDone}>{doneLabel}</Button>
      </Screen>
    );

  return (
    <Screen title="Link to your browser" {...(onBack && phase.s !== "sent" ? { onBack } : {})}>
      {phase.s === "ask" && (
        <>
          <Card className="flex flex-col gap-2">
            <p className="t-body">Link this phone&apos;s Vault to the browser that showed the code?</p>
            <p className="t-small text-muted">
              Vault key ends in <span className="t-mono">…{last8(vault.vaultPk)}</span>. Only public keys are sent,
              encrypted so that only that browser can read them.
            </p>
          </Card>
          <Button variant="vault" big onClick={() => void send()} data-testid="link-send">
            Link to browser
          </Button>
        </>
      )}
      {phase.s === "sending" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10">
          <Spinner label="Connecting to your browser…" />
          <p className="t-body text-muted">Connecting to your browser…</p>
        </div>
      )}
      {phase.s === "sent" && (
        <div className="flex flex-col gap-4" data-testid="link-sent">
          <div className="flex flex-col items-center gap-2 pt-4 text-center">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-safe-bg text-safe">
              <CheckIcon size={30} />
            </span>
            <p className="t-title">Sent to your browser</p>
            <p className="t-body text-muted">Check that the browser shows the same 4 words:</p>
          </div>
          <p className="text-center t-title t-mono tracking-wide" data-testid="link-words">
            {phase.words.join(" ")}
          </p>
          <p className="t-small text-muted">
            Different words? Then another phone answered the browser&apos;s code. Press “They don&apos;t match” in the
            browser and start again.
          </p>
          <Button variant="vault" onClick={onDone} data-testid="link-done">
            {doneLabel}
          </Button>
        </div>
      )}
      {phase.s === "error" && (
        <>
          <Banner level="danger" title="Couldn't reach your browser">
            {phase.message} If the browser&apos;s code is older than 5 minutes, show a fresh one there.
          </Banner>
          <Button variant="vault" onClick={() => void send()}>
            Try again
          </Button>
          {onBack && (
            <Button variant="secondary" onClick={onBack}>
              Cancel
            </Button>
          )}
        </>
      )}
    </Screen>
  );
}

/** Paste the browser's link or manual code (when the camera app can't open the link). */
export function EnterLinkCode() {
  const nav = useNav();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const c = parseManualCode(text);
        if (!c) return setError("That isn't a QueueBit link code. Copy it again from the browser.");
        nav.push({ name: "link", channel: c });
      }}
    >
      <TextField
        label="Code from the browser"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
        hint="In the browser: “Can't scan? Use the manual code”. Starts with QB1."
        autoComplete="off"
        error={error}
        data-testid="link-code"
      />
      <Button type="submit" variant="secondary" disabled={!text.trim()}>
        Link with this code
      </Button>
    </form>
  );
}

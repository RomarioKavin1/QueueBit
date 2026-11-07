"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Address, Choices, Notice, Title } from "@/components/onboarding/ui";
import { engine } from "@/lib/engine/client";
import { Row, Section } from "./bits";
import { errText, useWallet } from "./state";
import type { Nav } from "./Wallet";
import { RenameField } from "./Wallets";

/** The account at a glance, plus the few things a person does rarely: name it, move funds in, back up, lock. */
export function AccountTab({ nav }: { nav: Nav }) {
  const router = useRouter();
  const { status, net, lockedWith, backedUp, budget, wallet, wallets, refresh } = useWallet();
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const lock = async () => {
    try {
      await engine().call("keyring:lock");
      router.replace("/start");
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <>
      {renaming && wallet ? (
        <div className="mb-4">
          <RenameField
            wallet={wallet}
            onDone={async () => {
              setRenaming(false);
              await refresh();
            }}
          />
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <Title sub="Owned by a quantum-safe key. Test network.">{wallet?.name ?? "Account"}</Title>
          <button
            type="button"
            onClick={() => setRenaming(true)}
            disabled={!wallet}
            className="mono-label mt-1 h-10 shrink-0 border border-ink px-2.5 text-[11px] active:bg-paper-3 disabled:text-ink-3"
          >
            Rename
          </button>
        </div>
      )}
      {status?.address && (
        <div className="plate-grid relative px-5 pt-7 pb-5">
          <span aria-hidden className="fig-tag absolute top-3 right-2">
            [ ADDRESS ]
          </span>
          <Address value={status.address} className="block pr-6 text-[1.08rem] leading-[1.7]" />
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(status.address!).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              })
            }
            className="mono-label mt-4 h-10 border border-ink bg-paper px-3 active:bg-paper-3"
          >
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>
      )}
      <dl className="mt-6 border-t border-ink">
        <Row k="Status">{status ? (status.deployed ? "Created" : "Not created yet") : "…"}</Row>
        <Row k="Locked with">{lockedWith === "password" ? "Password" : lockedWith === "passkey" ? "Passkey" : "…"}</Row>
        <Row k="Backup">{backedUp === null ? "…" : backedUp ? "Words confirmed" : "Not backed up"}</Row>
        {status && (
          <Row k="Signatures left">
            {status.ownerSignaturesLeft.toLocaleString("en-US")}
            {budget ? ` of ${budget.toLocaleString("en-US")}` : ""}
          </Row>
        )}
        <Row k="Network">{net ? `${net.name} · ${net.chainId}` : "…"}</Row>
      </dl>

      <Section title="Do">
        <Choices
          items={[
            {
              key: "move-in",
              title: "Move funds in",
              body: "From MetaMask or another wallet address, or from a Safe, into this account.",
              onSelect: () => router.push("/start#move-in"),
            },
            {
              key: "wallets",
              title: (wallets?.wallets.length ?? 1) > 1 ? "Switch or add a wallet" : "Add a wallet",
              body: "Another wallet on this phone, with its own passkey or password. This one stays as it is.",
              onSelect: () => nav.open({ id: "wallets" }),
            },
            {
              key: "backup",
              title: backedUp ? "Show your 24 words" : "Back up your 24 words",
              body: "They rebuild this wallet on any device.",
              onSelect: () => router.push("/start#backup"),
            },
            {
              key: "guardians",
              title: "Guardians",
              body: status?.guardians?.length
                ? `${status.guardians.length} can reset your keys if you lose your passkey.`
                : "Who can reset your keys if you lose your passkey.",
              onSelect: () => nav.open({ id: "guardians" }),
            },
            {
              key: "permissions",
              title: "Let someone spend",
              body: "Give another wallet a limited allowance from this account, until a time you pick.",
              onSelect: () => nav.open({ id: "permissions" }),
            },
            {
              key: "lock",
              title: "Lock now",
              body: lockedWith === "password" ? "Your password opens it again." : "Your passkey opens it again.",
              onSelect: () => void lock(),
            },
          ]}
        />
      </Section>
      {err && <Notice tone="error">{err}</Notice>}
    </>
  );
}

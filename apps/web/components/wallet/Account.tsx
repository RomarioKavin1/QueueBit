"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LineArrow } from "@/components/onboarding/ui";
import { short } from "@/lib/format";
import { Identicon } from "./Identicon";
import { useWallet } from "./state";
import type { Nav } from "./Wallet";
import { RenameField } from "./Wallets";

/**
 * Settings for this wallet, as one short list: who it is, how it's kept safe, how money gets in. What Home and the
 * top bar already show (balance, account state, signatures, network, lock) isn't repeated here.
 */
export function AccountTab({ nav }: { nav: Nav }) {
  const router = useRouter();
  const { status, lockedWith, backedUp, wallet, wallets, refresh } = useWallet();
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = status?.address;
  const count = wallets?.wallets.length ?? 1;
  const guardians = status?.guardians?.length ?? 0;

  const copy = () =>
    address &&
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  return (
    <>
      {/* Who */}
      <div className="flex items-center gap-3.5">
        {address ? <Identicon address={address} size={52} /> : <span className="block size-[52px] bg-paper-3" />}
        <div className="min-w-0 flex-1">
          {renaming && wallet ? (
            <RenameField
              wallet={wallet}
              onDone={async () => {
                setRenaming(false);
                await refresh();
              }}
            />
          ) : (
            <>
              <h1 className="truncate text-[1.6rem] leading-tight">{wallet?.name ?? "Wallet"}</h1>
              <button
                type="button"
                onClick={copy}
                disabled={!address}
                aria-label={address ? `Copy address ${address}` : "Reading your address"}
                className="mt-0.5 flex h-8 items-center gap-1.5 font-mono text-[13px] text-ink-2 active:opacity-70"
              >
                {address ? short(address) : "…"}
                <span className="mono-label text-[11px] text-blue">{copied ? "Copied" : "Copy"}</span>
              </button>
            </>
          )}
        </div>
      </div>

      <Group title="Wallet">
        <Item label="Name" value={wallet?.name} onClick={() => setRenaming(true)} />
        <Item
          label={count > 1 ? "Switch or add a wallet" : "Add a wallet"}
          value={count > 1 ? `${count} on this phone` : undefined}
          onClick={() => nav.open({ id: "wallets" })}
        />
      </Group>

      <Group title="Security">
        <Item
          label={backedUp ? "Your 24 words" : "Back up your 24 words"}
          value={backedUp === null ? "…" : backedUp ? "Backed up" : "Not backed up"}
          tone={backedUp === false ? "warn" : undefined}
          onClick={() => router.push("/start#backup")}
        />
        <Item
          label="Guardians"
          value={guardians ? `${guardians}` : "None"}
          onClick={() => nav.open({ id: "guardians" })}
        />
        <Item label="Unlocks with" value={lockedWith === "password" ? "Password" : lockedWith ? "Passkey" : "…"} />
      </Group>

      <Group title="Funds">
        <Item label="Move funds in" value="From a wallet or Safe" onClick={() => router.push("/start#move-in")} />
      </Group>
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mono-label mb-2 text-[11px] text-ink-3">{title}</h2>
      <ul className="border-t border-ink">{children}</ul>
    </section>
  );
}

/** One setting: its name, its value, and (when it opens something) an arrow. */
function Item({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value?: string | undefined;
  tone?: "warn";
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex-1 text-[1.02rem]">{label}</span>
      {value !== undefined && (
        <span className={`truncate text-[0.95rem] ${tone === "warn" ? "text-red" : "text-ink-3"}`}>{value}</span>
      )}
      {onClick && <LineArrow className="shrink-0 text-ink-3" />}
    </>
  );
  return (
    <li className="border-b border-rule">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex min-h-[56px] w-full items-center gap-3 py-3 text-left active:bg-blue-wash"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-h-[56px] items-center gap-3 py-3">{body}</div>
      )}
    </li>
  );
}

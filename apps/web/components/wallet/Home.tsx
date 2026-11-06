"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Mark } from "@/components/paper/Logo";
import { Choices, LineArrow, Notice, Working } from "@/components/onboarding/ui";
import { askFaucet, waitForWei } from "@/lib/faucet";
import { ago, eth } from "@/lib/format";
import { engine } from "@/lib/engine/client";
import { EntryRow, GhostSeal, Section, SignatureGauge } from "./bits";
import { errText, useWallet } from "./state";
import type { Nav } from "./Wallet";

export function Home({ nav }: { nav: Nav }) {
  const router = useRouter();
  const { status, activity, budget, backedUp, net, error, refresh } = useWallet();
  const [faucet, setFaucet] = useState<"idle" | "asking" | "error">("idle");
  const [faucetErr, setFaucetErr] = useState<string | null>(null);

  const wei = BigInt(status?.accountWei ?? "0");
  const empty = status !== null && wei === 0n;
  const canFaucet = net !== undefined && !net.localDevnet;

  const getTestEth = async () => {
    if (!status?.address) return;
    setFaucet("asking");
    setFaucetErr(null);
    try {
      await askFaucet(status.address);
      await waitForWei(async () => BigInt((await engine().call("account:status", {})).accountWei ?? "0"), wei + 1n, 20);
      await refresh();
      setFaucet("idle");
    } catch (e) {
      setFaucet("error");
      setFaucetErr(errText(e));
    }
  };

  return (
    <>
      {/* Balance */}
      <section aria-label="Balance">
        <p className="mono-label text-ink-3">Balance</p>
        {status ? (
          <p className="mt-2 flex items-baseline gap-2.5">
            <span className="text-[clamp(2.8rem,13vw,3.6rem)] leading-none tracking-[-0.02em] tnum">{eth(wei, 5)}</span>
            <span className="mono-label text-[13px] text-ink-2">ETH</span>
          </p>
        ) : (
          <p className="mt-3 flex h-[3.2rem] items-center gap-3 mono-label text-ink-3">
            <Working /> Reading your account
          </p>
        )}
        {status && <p className="mt-2.5 mono-label text-[11px] text-ink-3">Test ETH · updated {ago(status.readAt)}</p>}
      </section>

      <div className="mt-7 grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => nav.open({ id: "send" })}
          disabled={!status?.address}
          className="mono-label flex h-12 items-center justify-center gap-2.5 border border-blue bg-blue text-[13px] text-on-blue active:brightness-90 disabled:border-rule disabled:bg-paper-3 disabled:text-ink-3"
        >
          Send <LineArrow />
        </button>
        <button
          type="button"
          onClick={() => nav.open({ id: "receive" })}
          disabled={!status?.address}
          className="mono-label flex h-12 items-center justify-center gap-2.5 border border-ink bg-paper text-[13px] active:bg-paper-3 disabled:text-ink-3"
        >
          Receive <LineArrow dir="left" />
        </button>
      </div>

      {error && !status?.address && <Notice tone="error">{error}</Notice>}

      {/* Account state: created, or an address waiting for its first payment */}
      {status?.address && (
        <div className="plate-grid mt-7 flex items-center gap-4 px-4 py-4">
          {status.deployed ? <Mark size={44} /> : <GhostSeal />}
          <div className="min-w-0">
            <p className="text-[1.02rem] leading-snug font-medium">
              {status.deployed ? "Account created" : "Not created yet"}
            </p>
            <p className="mt-0.5 text-[0.95rem] leading-[1.45] text-ink-2">
              {status.deployed
                ? "Owned by your quantum-safe key."
                : empty
                  ? "Add test ETH. Your first payment creates it."
                  : "Your first payment creates it."}
            </p>
          </div>
        </div>
      )}

      {empty && canFaucet && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={() => void getTestEth()}
            disabled={faucet === "asking"}
            className="mono-label flex h-12 w-full items-center justify-center gap-2.5 border border-ink bg-paper text-[13px] active:bg-paper-3 disabled:text-ink-3"
          >
            {faucet === "asking" ? (
              <>
                <Working /> Asking the test faucet
              </>
            ) : (
              "Get test ETH"
            )}
          </button>
          {faucetErr && <Notice tone="error">{faucetErr}</Notice>}
        </div>
      )}

      {backedUp === false && (
        <div className="mt-7">
          <Choices
            items={[
              {
                key: "backup",
                title: "Back up your 24 words",
                body: "Lose the phone without them, lose the wallet.",
                onSelect: () => router.push("/start#backup"),
              },
            ]}
          />
        </div>
      )}

      {status && (
        <Section title="Quantum-safe signatures left">
          <SignatureGauge left={status.ownerSignaturesLeft} budget={budget} />
        </Section>
      )}

      <Section
        title="Recent"
        aside={
          activity.length > 3 ? (
            <button type="button" onClick={() => nav.setTab("activity")} className="mono-label h-9 text-blue">
              All activity
            </button>
          ) : undefined
        }
      >
        {activity.length ? (
          <ul className="border-t border-ink">
            {activity.slice(0, 3).map((e) => (
              <EntryRow key={e.id} e={e} onOpen={() => nav.open({ id: "entry", entryId: e.id })} />
            ))}
          </ul>
        ) : (
          <p className="border-t border-ink py-4 text-[0.98rem] text-ink-3">
            Nothing sent yet. What you send shows here.
          </p>
        )}
      </Section>
    </>
  );
}

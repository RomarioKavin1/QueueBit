"use client";

import { Address, Notice, Screen, Secondary, Title } from "@/components/onboarding/ui";
import { eth, explorerLink } from "@/lib/format";
import { EntryRow, Row, entryOut, entryState, entryTitle } from "./bits";
import { useWallet, type ActivityEntry } from "./state";
import type { Nav } from "./Wallet";

export function ActivityTab({ nav }: { nav: Nav }) {
  const { activity } = useWallet();
  return (
    <>
      <Title sub="What this wallet sent, newest first.">Activity</Title>
      {activity.length ? (
        <ul className="border-t border-ink">
          {activity.map((e) => (
            <EntryRow key={e.id} e={e} onOpen={() => nav.open({ id: "entry", entryId: e.id })} />
          ))}
        </ul>
      ) : (
        <p className="border-t border-ink py-4 text-[0.98rem] text-ink-3">Nothing yet.</p>
      )}
    </>
  );
}

const SIGNER: Record<ActivityEntry["signer"], string> = {
  owner: "Quantum-safe key",
  session: "App allowance",
  setup: "Setup key",
  imported: "Your old wallet",
};

const KIND: Record<ActivityEntry["kind"], string> = {
  payment: "Payment",
  admin: "Account change",
  activation: "Account created",
  migration: "Move in",
};

/** The steps an owner-signed payment goes through, ticked from LeanPool's stage. */
function journey(e: ActivityEntry): Array<{ label: string; done: boolean }> | null {
  if (e.via !== "leanpool") return null;
  const done = e.status === "confirmed";
  const after = e.stage === "posted" || e.stage === "submitted" || e.stage === "mined";
  return [
    { label: "Signed with your quantum-safe key", done: true },
    { label: "Checked by LeanPool", done: e.stage !== undefined || done },
    { label: "Batched on chain", done: after || done },
    { label: "Confirmed", done },
  ];
}

export function EntryDetail({ nav, entryId }: { nav: Nav; entryId: string }) {
  const { activity, net } = useWallet();
  const e = activity.find((x) => x.id === entryId);
  if (!e)
    return (
      <Screen onBack={nav.back} method="Activity">
        <Title>Not found</Title>
      </Screen>
    );
  const st = entryState(e);
  const out = entryOut(e);
  const to = e.kind === "payment" && e.calls.length === 1 ? e.calls[0]!.target : undefined;
  const link = explorerLink(net?.explorerTxUrl, e.txHash ?? (e.via === "leanpool" ? undefined : e.hash));
  const steps = journey(e);

  return (
    <Screen
      onBack={nav.back}
      method="Activity"
      actions={
        link ? (
          <Secondary onClick={() => window.open(link, "_blank", "noopener")}>See it in the explorer</Secondary>
        ) : undefined
      }
    >
      <Title sub={new Date(e.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}>
        {entryTitle(e)}
      </Title>
      {to && (
        <div className="plate-grid relative mb-6 px-5 pt-7 pb-6">
          <span aria-hidden className="fig-tag absolute top-3 right-2">
            [ TO ]
          </span>
          <Address value={to} className="block pr-6 text-[1.08rem] leading-[1.7]" />
        </div>
      )}
      <dl className="border-t border-ink">
        <Row k="Status">
          <span className={st.tone === "red" ? "text-red" : st.tone === "blue" ? "text-blue" : ""}>{st.label}</span>
        </Row>
        <Row k="Kind">{KIND[e.kind]}</Row>
        {out !== null && <Row k="Amount">{eth(out, 8)} ETH</Row>}
        {e.feeWei && <Row k="Network fee">{eth(e.feeWei, 8)} ETH</Row>}
        <Row k="Signed by">{SIGNER[e.signer]}</Row>
        {e.origin && <Row k="Asked by">{e.origin}</Row>}
      </dl>
      {steps && (
        <ol className="mt-8 border-t border-ink">
          {steps.map((s) => (
            <li key={s.label} className="flex min-h-12 items-center justify-between gap-4 border-b border-rule py-3">
              <span className={`text-[1rem] ${s.done ? "" : "text-ink-3"}`}>{s.label}</span>
              {s.done && <span className="mono-label text-blue">Done</span>}
            </li>
          ))}
        </ol>
      )}
      {e.status === "failed" && e.detail && <Notice tone="error">{e.detail}</Notice>}
    </Screen>
  );
}

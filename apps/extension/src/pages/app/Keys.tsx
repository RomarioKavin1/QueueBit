import { useState } from "react";
import type { WalletState } from "../../shared/types";
import type { KeyView } from "../../shared/views";
import { AddressChip, Button, Card, RiskBanner, Skeleton } from "../../ui";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";

/**
 * Keys & recovery (replaces Security): the keys on the account as the network has them, guardians, any recovery a
 * guardian started (the owner can cancel it before it is ready), ended keys to clean up, and the backup words.
 */
export function Keys({ state }: { state: WalletState }) {
  const chainId = state.settings.selectedChainId;
  const view = useAsync(() => call("keys:view", { chainId }), [chainId]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const v = view.data;
  const expired = (v?.keys ?? []).filter((k) => k.expired);
  const nowSec = Math.floor(Date.now() / 1000);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof UiCallError ? e.message : "That didn't work." });
    }
  };

  return (
    <div className="flex max-w-[640px] flex-col gap-5">
      <div>
        <h1 className="text-[24px] leading-[30px] font-semibold">Keys & recovery</h1>
        <p className="t-body mt-1 text-muted">Who can do what with your account, as the network has it.</p>
      </div>
      {msg && <RiskBanner level={msg.ok ? "info" : "danger"} title={msg.text} />}
      {!v ? (
        view.error ? (
          <RiskBanner level="danger" title={view.error} />
        ) : (
          <Skeleton className="h-40 w-full" label="Reading your keys" />
        )
      ) : (
        <>
          <Card heading="Owner key">
            <p className="t-small text-muted">
              Quantum-safe (leanSPHINCS), made from your backup words. It can change anything and pay anything.
            </p>
            <p className="t-small mt-2" data-testid="owner-signatures">
              {v.ownerSignaturesLeft.toLocaleString()} of {v.ownerSignatureBudget.toLocaleString()} signatures left.
            </p>
          </Card>

          <section aria-labelledby="keys-h" className="flex flex-col gap-2">
            <h2 id="keys-h" className="t-strong">
              Keys on the account
            </h2>
            {!v.deployed ? (
              <p className="t-small text-muted">Your account isn&apos;t created yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line" data-testid="key-list">
                {v.keys.map((k) => (
                  <KeyRow key={k.id} k={k} />
                ))}
              </ul>
            )}
            {expired.length > 0 && (
              <Button
                variant="secondary"
                className="self-start"
                onClick={() =>
                  void act(
                    () => call("keys:prune", { chainId, ids: expired.map((k) => k.id) }),
                    "Removing the ended keys. Activity shows when it's done.",
                  ).then(() => view.reload())
                }
              >
                Remove {expired.length} ended key{expired.length > 1 ? "s" : ""}
              </Button>
            )}
          </section>

          <section aria-labelledby="guardians-h" className="flex flex-col gap-2">
            <h2 id="guardians-h" className="t-strong">
              Guardians
            </h2>
            {v.guardians.length === 0 ? (
              <p className="t-small text-muted">
                None. Guardians are chosen before the account is created (setup); your backup words are your recovery.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {v.guardians.map((g) => (
                  <li key={g.address} className="flex items-center gap-2">
                    <AddressChip address={g.address} />
                    <span className="t-small text-muted">{g.active ? "Active" : "Not active yet"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="recovery-h" className="flex flex-col gap-2">
            <h2 id="recovery-h" className="t-strong">
              Recoveries in progress
            </h2>
            {v.recoveries.length === 0 ? (
              <p className="t-small text-muted">None.</p>
            ) : (
              v.recoveries.map((r) => (
                <RiskBanner
                  key={r.id}
                  level="danger"
                  title={`Guardians started replacing your keys (${r.approvals} approval${r.approvals === 1 ? "" : "s"})`}
                  body={
                    r.readyAt > nowSec
                      ? `It can be carried out after ${new Date(r.readyAt * 1000).toLocaleString()}. If you didn't ask for this, cancel it.`
                      : "It can be carried out now. If you didn't ask for this, cancel it."
                  }
                  action={{
                    label: "Cancel it",
                    onClick: () =>
                      void act(() => call("keys:cancelRecovery", { chainId, id: r.id }), "Cancelling the recovery."),
                  }}
                />
              ))
            )}
          </section>

          <section aria-labelledby="backup-h" className="flex flex-col gap-2">
            <h2 id="backup-h" className="t-strong">
              Backup words
            </h2>
            <p className="t-small text-muted">
              {state.setup.backupConfirmedAt ? "Backed up." : "Not backed up yet."} They restore your account and every
              key in it.
            </p>
            <Button variant="secondary" className="self-start" onClick={() => (location.hash = "#backup")}>
              Back up your words
            </Button>
          </section>
        </>
      )}
    </div>
  );
}

function KeyRow({ k }: { k: KeyView }) {
  const roles = [k.admin && "changes settings", k.spend && "pays", k.session && "session"].filter(Boolean).join(", ");
  return (
    <li className="flex flex-col gap-0.5 px-3 py-2">
      <span className="t-strong">
        {k.isOwnerKey ? "Owner key (this browser)" : k.kind}
        {k.quantumSafe && <span className="t-small ml-2 text-safe">quantum-safe</span>}
      </span>
      <span className="t-small text-muted">
        {roles || "no role"}
        {k.validUntil ? ` · ${k.expired ? "ended" : "ends"} ${new Date(k.validUntil * 1000).toLocaleString()}` : ""}
      </span>
      {k.address && <AddressChip address={k.address} copyable={false} />}
    </li>
  );
}

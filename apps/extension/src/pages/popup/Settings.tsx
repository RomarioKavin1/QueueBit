import { useState } from "react";
import { NETWORKS } from "../../shared/chains";
import { AUTO_LOCK_CHOICES, type Theme, type WalletState } from "../../shared/types";
import { AddressChip, ArrowLeftIcon, Button, Card, LockIcon, PasswordField, SelectField } from "../../ui";
import { formatMinutes, formatUsd } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { eth } from "../lib/money";
import { ResetSheet } from "../common/Unlock";
import { PrivacyNetworkSection, PrivateConnectionSection } from "../common/PrivacySettings";

export function SettingsScreen({ state, onBack }: { state: WalletState; onBack: () => void }) {
  const [resetOpen, setResetOpen] = useState(false);
  const s = state.settings;
  const net = NETWORKS.find((n) => n.chainId === s.selectedChainId);
  return (
    <div className="flex flex-col">
      <header className="flex h-12 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid size-10 place-items-center rounded-md hover:bg-surface-2"
        >
          <ArrowLeftIcon />
        </button>
        <h1 className="t-title">Settings</h1>
      </header>
      <div className="flex flex-col gap-5 p-4">
        <AccountSection chainId={s.selectedChainId} />

        <section className="flex flex-col gap-3" aria-labelledby="gen-h">
          <h2 id="gen-h" className="t-small font-semibold tracking-wide text-muted uppercase">
            General
          </h2>
          <SelectField
            label="Network"
            value={String(s.selectedChainId)}
            options={NETWORKS.map((n) => ({
              value: String(n.chainId),
              label: `${n.name} · ${n.accountKind}${n.enabled ? "" : " (not available yet)"}`,
            }))}
            onChange={(e) => void call("settings:update", { selectedChainId: Number(e.target.value) })}
            description={`${net?.note ?? ""} LEAKED uses a fixed list so a site can't point you at a fake network.`}
          />
          <SelectField
            label="Lock automatically after"
            value={String(s.autoLockMinutes)}
            options={AUTO_LOCK_CHOICES.map((m) => ({ value: String(m), label: formatMinutes(m) }))}
            onChange={(e) => void call("settings:update", { autoLockMinutes: Number(e.target.value) })}
            description="LEAKED also locks when you close the browser."
          />
          <SelectField
            label="Theme"
            value={s.theme}
            options={[
              { value: "system", label: "Same as system" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(e) => void call("settings:update", { theme: e.target.value as Theme })}
          />
          <Button variant="secondary" icon={<LockIcon size={18} />} onClick={() => void call("keyring:lock")}>
            Lock now
          </Button>
        </section>

        <PrivateConnectionSection chainId={s.selectedChainId} enabled={s.anonRpc} />
        <PrivacyNetworkSection chainId={s.selectedChainId} />

        <section className="flex flex-col gap-2" aria-labelledby="alerts-h">
          <h2 id="alerts-h" className="t-small font-semibold tracking-wide text-muted uppercase">
            Alerts
          </h2>
          <p className="t-small text-muted">
            In-browser alerts are always on while the browser is open. Pair a self-hosted watcher in Security to get
            them when it is closed. Alerts never include amounts or addresses.
          </p>
        </section>

        <section className="flex flex-col gap-2" aria-labelledby="tank-h">
          <h2 id="tank-h" className="t-small font-semibold tracking-wide text-muted uppercase">
            Fee tank
          </h2>
          <Card>
            <p className="t-small text-muted">
              Pays network fees for everyday payments; a thief can only burn this. Topping it up counts as an everyday
              payment.
            </p>
            <div className="mt-2">
              {state.accounts && <AddressChip address={state.accounts.feeTank} name="Fee tank" />}
            </div>
          </Card>
        </section>

        <ChangePassword />

        <section className="flex flex-col gap-2" aria-labelledby="danger-h">
          <h2 id="danger-h" className="t-small font-semibold tracking-wide text-danger uppercase">
            Danger zone
          </h2>
          <Button variant="danger-outline" onClick={() => setResetOpen(true)}>
            Reset this browser
          </Button>
        </section>
        <p className="t-small text-center text-muted">LEAKED preview build · test money only</p>
      </div>
      <ResetSheet open={resetOpen} onClose={() => setResetOpen(false)} />
    </div>
  );
}

/** Account status on the current network (plan §30 §7 Settings; ux-spec §3.13). */
function AccountSection({ chainId }: { chainId: number }) {
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const st = status.data;
  const net = NETWORKS.find((n) => n.chainId === chainId);
  const rows: Array<[string, React.ReactNode]> = st
    ? [
        ["Address", <AddressChip key="a" address={st.address} chain={net?.accountKind} />],
        [
          "Status",
          !st.supported ? (
            (st.unsupportedReason ?? "Not available on this network")
          ) : st.deployed ? (
            <span key="s" className="text-safe">
              Active
            </span>
          ) : st.activation ? (
            "Activating…"
          ) : (
            "Not activated yet"
          ),
        ],
        ...(st.supported
          ? ([
              [
                "Daily limit",
                `${formatUsd(st.limits.capUsd)} in any 24 hours · ${formatUsd(st.limits.perTxMaxUsd)} per payment${st.deployed ? ` · ${formatUsd(st.limits.availableUsd)} left` : " (set at activation)"}`,
              ],
              ["Allowed recipients", "Your fee tank. Adding others needs the Vault."],
              [
                "Vault",
                st.vault === "paired"
                  ? `Paired${st.vaultSigner ? ` · signer ${st.vaultSigner.slice(0, 6)}…` : ""}`
                  : "Not paired",
              ],
              ["Recovery key", st.recoverySigner ? "Set" : "Not set"],
              ["Fee tank", eth(st.tankWei, 6)],
            ] as Array<[string, React.ReactNode]>)
          : []),
      ]
    : [];
  return (
    <section className="flex flex-col gap-2" aria-labelledby="acct-h">
      <h2 id="acct-h" className="t-small font-semibold tracking-wide text-muted uppercase">
        Account
      </h2>
      {!st ? (
        <p className="t-small text-muted">{status.error ? "Can't reach the network right now." : "Loading…"}</p>
      ) : (
        <dl className="divide-y divide-line rounded-md border border-line" data-testid="account-status">
          {rows.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 px-3 py-2">
              <dt className="t-small text-muted">{k}</dt>
              <dd className="t-body">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [oldPw, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && confirm !== pw;

  return (
    <section className="flex flex-col gap-2" aria-labelledby="pw-h">
      <h2 id="pw-h" className="t-small font-semibold tracking-wide text-muted uppercase">
        Password
      </h2>
      {!open ? (
        <>
          <Button variant="secondary" onClick={() => (setOpen(true), setDone(false))}>
            Change password
          </Button>
          {done && (
            <p role="status" className="t-small text-safe">
              Password changed.
            </p>
          )}
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (tooShort || mismatch || !pw) return;
            setBusy(true);
            setError(null);
            try {
              await call("keyring:changePassword", { oldPassword: oldPw, newPassword: pw });
              setOpen(false);
              setDone(true);
              setOld("");
              setPw("");
              setConfirm("");
            } catch (err) {
              setError(err instanceof UiCallError ? err.message : "Couldn't change the password.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <PasswordField
            label="Current password"
            autoComplete="current-password"
            value={oldPw}
            onChange={(e) => setOld(e.target.value)}
            error={error ?? undefined}
          />
          <PasswordField
            label="New password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            error={tooShort ? "Use at least 8 characters." : undefined}
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={mismatch ? "Passwords don't match." : undefined}
          />
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              block
              loading={busy}
              loadingLabel="Securing…"
              disabled={!oldPw || !pw || tooShort || mismatch || !confirm}
            >
              Save
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

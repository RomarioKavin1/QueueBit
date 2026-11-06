import { useState, type ReactNode } from "react";
import { isAddress, type Address } from "viem";
import type { WalletState } from "../../shared/types";
import { Button, Card, RecoveryIcon, RiskBanner, Sheet, Skeleton, TextField, VaultIcon, WalletIcon } from "../../ui";
import { cx } from "../../ui/cx";
import { formatUsd } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { eth } from "../lib/money";
import { startVault } from "./vaultStart";

type SheetKind = "pause" | "rotate" | "lockdown" | "guardian" | null;

/**
 * Security center (ux-spec §3.10): status of the three tiers and the Guardian, and the protective actions, each a
 * Vault approval with its consequence said before the button.
 */
export function Security({ state }: { state: WalletState }) {
  const status = useAsync(() => call("account:status", {}), []);
  const signers = useAsync(() => call("vault:signers", {}), []);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guardian, setGuardian] = useState(state.setup.guardian?.address ?? "");
  const [guardianName, setGuardianName] = useState(state.setup.guardian?.name ?? "");
  const s = status.data;
  const vaultSigner = signers.data?.find((x) => x.role === "vault");
  const recoverySigner = signers.data?.find((x) => x.role === "recovery");
  const hasRecovery = !!s?.recoverySigner;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };

  if (!s) return <Skeleton className="h-64" />;
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[24px] leading-[30px] font-semibold">Security</h1>
      {s.bunker && (
        <RiskBanner
          level="danger"
          title="Lockdown is on. Everyday spending is off until the Vault issues a new everyday key."
        />
      )}
      {error && <RiskBanner level="danger" title={error} />}
      <section aria-labelledby="status-h" className="flex flex-col gap-2">
        <h2 id="status-h" className="t-small font-semibold tracking-wide text-muted uppercase">
          Status
        </h2>
        <Row
          icon={<WalletIcon size={20} />}
          tone="safe"
          name="Everyday spending"
          value={
            s.bunker
              ? "Off (Lockdown)"
              : s.frozen
                ? `Paused${s.frozenUntil && s.frozenUntil < 2 ** 40 ? ` until ${new Date(s.frozenUntil * 1000).toLocaleString("en-GB")}` : ""}`
                : `Active · limit ${formatUsd(s.limits.capUsd)} in any 24 hours`
          }
        />
        <Row
          icon={<VaultIcon size={20} />}
          tone="vault"
          name="Vault"
          value={
            vaultSigner
              ? `Paired · key …${vaultSigner.pkLast8} · ${vaultSigner.schemeName}${vaultSigner.deployed ? ` · fee balance ${eth(vaultSigner.balanceWei, 4)}` : " · not on the network yet"}`
              : state.setup.vault
                ? "Paired (activates with your account)"
                : "Not paired"
          }
          {...(vaultSigner ? { detail: vaultSigner.lane.text } : {})}
        />
        <Row
          icon={<RecoveryIcon size={20} />}
          tone="brand"
          name="Recovery key"
          value={
            hasRecovery
              ? `Set · key …${recoverySigner?.pkLast8 ?? state.setup.recovery?.pk.slice(-8)}${state.setup.recovery?.testedAt ? " · tested" : ""}`
              : state.setup.recovery?.testedAt
                ? "Tested, not linked to the account yet"
                : state.setup.recovery
                  ? "Scanned, not tested yet (not part of your account)"
                  : "Not set"
          }
          {...(recoverySigner ? { detail: recoverySigner.lane.text } : {})}
          action={
            !hasRecovery && state.setup.recovery && !state.setup.recovery.testedAt ? (
              <Button size="sm" variant="secondary" onClick={() => (location.hash = "#onboarding/recovery")}>
                Finish the test
              </Button>
            ) : !hasRecovery && state.setup.recovery && s.deployed ? (
              <Button
                size="sm"
                variant="vault"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    startVault({ type: "setRecoverySigner", signer: "0x0000000000000000000000000000000000000000" }),
                  )
                }
              >
                Link with Vault
              </Button>
            ) : !state.setup.recovery ? (
              <Button size="sm" variant="secondary" onClick={() => (location.hash = "#onboarding/recovery")}>
                Set up
              </Button>
            ) : undefined
          }
        />
        <Row
          icon={<span aria-hidden="true">◇</span>}
          tone="brand"
          name="Guardian"
          value={
            state.setup.guardian
              ? `${state.setup.guardian.name ?? ""} ${state.setup.guardian.address.slice(0, 6)}…${state.setup.guardian.address.slice(-4)} · can pause once every 7 days`
              : "None"
          }
          action={
            <Button size="sm" variant="secondary" onClick={() => setSheet("guardian")}>
              {state.setup.guardian ? "Change" : "Add"}
            </Button>
          }
        />
        <Row icon={<span aria-hidden="true">◇</span>} tone="brand" name="Alerts" value="In-browser (always on)" />
      </section>

      <section aria-labelledby="actions-h" className="flex flex-col gap-2">
        <h2 id="actions-h" className="t-small font-semibold tracking-wide text-muted uppercase">
          Actions
        </h2>
        {s.frozen ? (
          <Action
            name="Resume everyday spending"
            note="instant, with your Vault"
            button={
              <Button
                size="sm"
                variant="vault"
                disabled={busy || !s.deployed}
                onClick={() => run(() => startVault({ type: "unfreeze" }))}
              >
                Resume with Vault
              </Button>
            }
          />
        ) : (
          <Action
            name="Pause everyday spending"
            note="instant; only your phone can resume it"
            button={
              <Button
                size="sm"
                variant="vault"
                disabled={busy || !s.deployed || s.bunker}
                onClick={() => setSheet("pause")}
              >
                Pause
              </Button>
            }
          />
        )}
        <Action
          name="Replace everyday key"
          note="instant, Vault approval; also the way out of Lockdown"
          button={
            <Button size="sm" variant="vault" disabled={busy || !s.deployed} onClick={() => setSheet("rotate")}>
              Replace
            </Button>
          }
        />
        <Action
          name="Lockdown"
          note={hasRecovery ? "stops all everyday spending" : "Needs a Recovery key first"}
          button={
            <Button
              size="sm"
              variant="danger-outline"
              disabled={busy || !s.deployed || !hasRecovery || s.bunker}
              onClick={() => setSheet("lockdown")}
            >
              Start Lockdown
            </Button>
          }
        />
        <Action name="Replace the Vault" note="Recovery key · 7 days (from the Vault app's Recovery mode)" />
      </section>

      <Sheet open={sheet === "pause"} title="Pause everyday spending now?" onClose={() => setSheet(null)}>
        <p className="t-body">Payments, sign-ins and allowances stop. Only your phone can resume it.</p>
        {state.setup.guardian && (
          <p className="t-small mt-2 text-muted">
            Or ask your Guardian to pause it: they can do it without your phone (once every 7 days, ends after 72 h).
          </p>
        )}
        <SheetButtons onBack={() => setSheet(null)}>
          <Button block variant="vault" loading={busy} onClick={() => run(() => startVault({ type: "freeze" }))}>
            Pause with Vault
          </Button>
        </SheetButtons>
      </Sheet>
      <Sheet open={sheet === "rotate"} title="Replace the everyday key?" onClose={() => setSheet(null)}>
        <p className="t-body">
          Use this if you think this browser might be compromised. The old key stops working immediately. Your address
          stays the same.
        </p>
        <SheetButtons onBack={() => setSheet(null)}>
          <Button
            block
            variant="vault"
            loading={busy}
            onClick={() =>
              run(async () => {
                const next = await call("security:nextEverydayKey");
                await startVault({ type: "setHotKey", hotKey: next.address, index: next.index });
              })
            }
          >
            Replace with Vault
          </Button>
        </SheetButtons>
      </Sheet>
      <Sheet open={sheet === "lockdown"} title="Start Lockdown?" onClose={() => setSheet(null)}>
        <p className="t-body">
          Lockdown switches everyday spending off completely. To turn it back on, your phone issues a new everyday key.
          Use it if you've lost this computer or the browser is compromised.
        </p>
        <SheetButtons onBack={() => setSheet(null)}>
          <Button block variant="vault" loading={busy} onClick={() => run(() => startVault({ type: "lockdown" }))}>
            Start Lockdown with Vault
          </Button>
        </SheetButtons>
      </Sheet>
      <Sheet open={sheet === "guardian"} title="Guardian" onClose={() => setSheet(null)}>
        <GuardianForm address={guardian} name={guardianName} onAddress={setGuardian} onName={setGuardianName} />
        <SheetButtons onBack={() => setSheet(null)}>
          {state.setup.guardian && (
            <Button
              block
              variant="secondary"
              disabled={busy}
              onClick={() =>
                run(() => startVault({ type: "setGuardian", guardian: state.setup.guardian!.address, enabled: false }))
              }
            >
              Remove
            </Button>
          )}
          <Button
            block
            variant="vault"
            loading={busy}
            disabled={!isAddress(guardian) || !s.deployed}
            onClick={() =>
              run(async () => {
                await call("setup:update", {
                  guardian: {
                    address: guardian as Address,
                    ...(guardianName ? { name: guardianName } : {}),
                    requestedAt: Date.now(),
                  },
                });
                await startVault({
                  type: "setGuardian",
                  guardian: guardian as Address,
                  enabled: true,
                  ...(guardianName ? { name: guardianName } : {}),
                });
              })
            }
          >
            Add Guardian with Vault
          </Button>
        </SheetButtons>
      </Sheet>
    </div>
  );
}

export function GuardianForm({
  address,
  name,
  onAddress,
  onName,
}: {
  address: string;
  name: string;
  onAddress: (v: string) => void;
  onName: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="t-body">
        A Guardian can pause your everyday spending if they think something is wrong. That's all they can do.
      </p>
      <TextField
        label="Address"
        value={address}
        onChange={(e) => onAddress(e.target.value.trim())}
        spellCheck={false}
        error={address && !isAddress(address) ? "That doesn't look like an address." : undefined}
      />
      <TextField label="Name (only on this browser)" value={name} onChange={(e) => onName(e.target.value)} />
      <ul className="t-small flex list-disc flex-col gap-1 pl-5 text-muted">
        <li>Can pause everyday spending, once every 7 days</li>
        <li>The pause ends by itself after 72 hours</li>
        <li>Cannot move money, change limits or see your phone</li>
        <li>You can remove them any time (Vault approval)</li>
      </ul>
    </div>
  );
}

function SheetButtons({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="mt-4 flex gap-2">
      <Button variant="secondary" block onClick={onBack}>
        Go back
      </Button>
      {children}
    </div>
  );
}

function Row({
  icon,
  tone,
  name,
  value,
  detail,
  action,
}: {
  icon: ReactNode;
  tone: "safe" | "vault" | "brand";
  name: string;
  value: string;
  detail?: string;
  action?: ReactNode;
}) {
  const c = { safe: "bg-safe-bg text-safe", vault: "bg-vault-bg text-vault", brand: "bg-surface-2 text-fg" }[tone];
  return (
    <Card className="flex items-center gap-3">
      <span className={cx("grid size-9 shrink-0 place-items-center rounded-md", c)}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="t-strong">{name}</p>
        <p className="t-small text-muted" data-testid={`security-${name.toLowerCase().replace(/\s+/gu, "-")}`}>
          {value}
        </p>
        {detail && <p className="t-small text-muted">{detail}</p>}
      </div>
      {action}
    </Card>
  );
}

function Action({ name, note, button }: { name: string; note: string; button?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
      <div>
        <p className="t-strong">{name}</p>
        <p className="t-small text-muted">{note}</p>
      </div>
      {button}
    </div>
  );
}

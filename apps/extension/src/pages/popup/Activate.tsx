import { useState } from "react";
import { getNetwork } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import {
  AddressChip,
  ArrowLeftIcon,
  Button,
  QrCode,
  RiskBanner,
  Skeleton,
  Timeline,
  type TimelineStep,
} from "../../ui";
import { formatUsd, groupedAddress } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth } from "../lib/money";

/**
 * Activate the account (plan §30 §7 "deploy account"): the fee tank pays for `AccountFactory.createAccount` with the
 * init config fixed at setup (daily limit, per-payment limit, the fee tank allowed, the ETH price). Two steps the user
 * can see: put a little ETH in the fee tank, then activate.
 */
export function ActivateScreen({ state, onBack }: { state: WalletState; onBack: () => void }) {
  const chainId = state.settings.selectedChainId;
  const net = getNetwork(chainId);
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  const tankOk = s ? BigInt(s.tankWei) >= BigInt(s.activationCostWei) && BigInt(s.activationCostWei) > 0n : false;
  usePoll(status.reload, 3000, Boolean(s && !s.deployed));

  const steps: TimelineStep[] = s
    ? [
        {
          label: `Add ETH to your fee tank (at least ${eth(s.activationCostWei, 4)})`,
          status: tankOk ? "done" : "active",
        },
        {
          label: "Activate: your limits go on the network",
          status: s.deployed ? "done" : s.activation ? "active" : tankOk ? "active" : "pending",
        },
      ]
    : [];

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
        <h1 className="t-title">Activate account</h1>
      </header>
      <div className="flex flex-col gap-4 p-4">
        {!s ? (
          <Skeleton className="h-40 w-full" label="Loading account" />
        ) : s.deployed ? (
          <>
            <RiskBanner
              level="info"
              title="Your account is active"
              body={`Daily limit ${formatUsd(s.limits.capUsd)} in any 24 hours · up to ${formatUsd(s.limits.perTxMaxUsd)} per payment.`}
            />
            <Button block onClick={onBack}>
              Done
            </Button>
          </>
        ) : !s.supported ? (
          <RiskBanner level="info" title="Not available on this network" body={s.unsupportedReason} />
        ) : (
          <>
            <p className="t-body">
              Activation puts your limits on {net.name}: {formatUsd(s.limits.capUsd || state.setup.dailyLimitUsd)} in
              any 24 hours, up to {formatUsd(s.limits.perTxMaxUsd || state.setup.perPaymentUsd)} per payment. Your fee
              tank pays the one-time network fee.
            </p>
            <Timeline steps={steps} label="Activation steps" />
            {!tankOk && (
              <div className="flex flex-col items-center gap-2 rounded-md border border-line p-3">
                <p className="t-small self-start text-muted">
                  Send ETH on {net.name} to your fee tank. It pays network fees for everyday payments; a thief can only
                  burn what's in it. About 0.01 ETH lasts many payments.
                </p>
                <QrCode value={s.tank} size={148} label={`QR code of your fee tank ${groupedAddress(s.tank)}`} />
                <AddressChip address={s.tank} name="Fee tank" />
                <p className="t-small text-muted" data-testid="tank-balance">
                  In the tank: {eth(s.tankWei)}
                </p>
              </div>
            )}
            {error && <RiskBanner level="danger" title={error} />}
            <Button
              block
              disabled={!tankOk || Boolean(s.activation)}
              loading={busy || Boolean(s.activation)}
              loadingLabel="Activating…"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await call("account:activate", { chainId });
                  await status.reload();
                } catch (e) {
                  setError(e instanceof UiCallError ? e.message : "Couldn't activate. Try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Activate account
            </Button>
            <p className="t-small text-muted">
              Your account address stays the same: <AddressChip address={s.address} copyable={false} />
            </p>
          </>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { getNetwork } from "../../shared/chains";
import { BUILD_FAUCET_URL, LOCAL_DEVNET } from "../../shared/build";
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
import { groupedAddress } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth } from "../lib/money";

/**
 * Create the account: the setup key sends `LeanAccountFactory.createAccount` with the configuration the address is
 * bound to (the owner key, the LeanPool node, guardians). Two steps the user can see: put a little ETH on the setup
 * key, then create.
 */
export function ActivateScreen({ state, onBack }: { state: WalletState; onBack: () => void }) {
  const chainId = state.settings.selectedChainId;
  const net = getNetwork(chainId);
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  const tankOk =
    s?.setupWei !== undefined && s.activationCostWei !== undefined
      ? BigInt(s.setupWei) >= BigInt(s.activationCostWei) && BigInt(s.activationCostWei) > 0n
      : false;
  const [funding, setFunding] = useState<string | null>(null);
  usePoll(status.reload, 3000, Boolean(s && !s.deployed));

  const steps: TimelineStep[] = s
    ? [
        {
          label: `Add ETH to your setup key (at least ${eth(s.activationCostWei ?? "0", 4)})`,
          status: tankOk ? "done" : "active",
        },
        {
          label: "Create the account on the network",
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
        <h1 className="t-title">Create account</h1>
      </header>
      <div className="flex flex-col gap-4 p-4">
        {!s ? (
          <Skeleton className="h-40 w-full" label="Loading account" />
        ) : s.deployed ? (
          <>
            <RiskBanner
              level="info"
              title="Your account is active"
              body="Fund it from Receive; payments are signed with your quantum-safe owner key."
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
              Your setup key creates your account on {net.name} with your quantum-safe owner key, and pays the one-time
              network fee.
            </p>
            <Timeline steps={steps} label="Activation steps" />
            {!tankOk && (
              <div className="flex flex-col items-center gap-2 rounded-md border border-line p-3">
                <p className="t-small self-start text-muted">
                  Send a little ETH on {net.name} to your setup key. It pays for creating the account and for moves into
                  it, and holds nothing else.
                </p>
                <QrCode
                  value={s.setupKey}
                  size={148}
                  label={`QR code of your setup key ${groupedAddress(s.setupKey)}`}
                />
                <AddressChip address={s.setupKey} name="Setup key" />
                <p className="t-small text-muted" data-testid="setup-balance">
                  On the setup key: {eth(s.setupWei ?? "0")}
                </p>
                {LOCAL_DEVNET && BUILD_FAUCET_URL && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      setFunding("Asking the faucet…");
                      try {
                        const u = new URL(BUILD_FAUCET_URL);
                        u.searchParams.set("address", s.setupKey);
                        const r = await fetch(u, { method: "POST" });
                        setFunding(r.ok ? "Test ETH is on its way." : "The faucet said no.");
                        setTimeout(() => void status.reload(), 3000);
                      } catch {
                        setFunding("The faucet isn't answering.");
                      }
                    }}
                  >
                    Get test ETH
                  </Button>
                )}
                {funding && <p className="t-small text-muted">{funding}</p>}
              </div>
            )}
            {error && <RiskBanner level="danger" title={error} />}
            <Button
              block
              disabled={!tankOk || Boolean(s.activation)}
              loading={busy || Boolean(s.activation)}
              loadingLabel="Creating…"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await call("account:activate", { chainId });
                  await status.reload();
                } catch (e) {
                  setError(e instanceof UiCallError ? e.message : "Couldn't create the account. Try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create account
            </Button>
            {s.address && (
              <p className="t-small text-muted">
                Your account address stays the same: <AddressChip address={s.address} copyable={false} />
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

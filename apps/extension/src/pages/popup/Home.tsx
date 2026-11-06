import { useState } from "react";
import { getNetwork } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import type { AccountStatus } from "../../shared/views";
import {
  AddressChip,
  Button,
  Card,
  CheckIcon,
  QrCode,
  ReceiveIcon,
  RefreshIcon,
  RiskBanner,
  SendIcon,
  Sheet,
  Skeleton,
} from "../../ui";
import { formatRelative, groupedAddress } from "../../ui/format";
import { call } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth } from "../lib/money";

/** The owner key is near its safe limit below this many signatures (ux-spec: replace it before it runs out). */
const LOW_SIGNATURES = 1000;

export function Home({
  state,
  onSend,
  onActivate,
  onOpenApp,
}: {
  state: WalletState;
  onSend: () => void;
  onActivate: () => void;
  onOpenApp: (hash: string) => void;
}) {
  const chainId = state.settings.selectedChainId;
  const net = getNetwork(chainId);
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const s = status.data;
  usePoll(status.reload, 3000, Boolean(s?.activation && !s.deployed));

  return (
    <div className="flex flex-col gap-4 p-4">
      {!state.setup.completedAt && (
        <RiskBanner
          level="info"
          title="Finish setting up"
          body="A few steps are left."
          action={{ label: "Continue setup", onClick: () => onOpenApp("#onboarding") }}
        />
      )}
      {s && s.ownerSignaturesLeft < LOW_SIGNATURES && (
        <RiskBanner
          level="danger"
          title="Your owner key is near its safe limit"
          body={`${s.ownerSignaturesLeft} signatures left. Add a new owner key before it runs out.`}
          action={{ label: "Keys & recovery", onClick: () => onOpenApp("#keys") }}
        />
      )}

      <section aria-labelledby="balance-h">
        <div className="flex items-center justify-between">
          <h2 id="balance-h" className="t-small text-muted">
            Balance on {net.name}
          </h2>
          <button
            type="button"
            onClick={() => void status.reload()}
            aria-label="Refresh balance"
            className="grid size-8 place-items-center rounded-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            <RefreshIcon size={16} />
          </button>
        </div>
        {s?.accountWei !== undefined ? (
          <p className="t-display mt-0.5" data-testid="balance">
            {eth(s.accountWei, 4).replace(" ETH", "")} <span className="t-title text-muted">ETH</span>
          </p>
        ) : status.error || s?.error || s?.supported === false ? null : (
          <Skeleton className="mt-1 h-[34px] w-40" label="Loading balance" />
        )}
        {s?.supported === false ? (
          <p role="status" className="t-small mt-1 text-limit">
            {s.unsupportedReason}
          </p>
        ) : status.error || s?.error ? (
          <p role="status" className="t-small mt-1 text-limit">
            {s?.error ?? "Can't reach the network right now."}{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => void status.reload()}>
              Retry
            </button>
          </p>
        ) : (
          s?.address && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <AddressChip address={s.address} chain="Quantum-safe account" />
              <span className="t-small text-muted">
                {s.deployed ? "Active" : "Not created yet"} · updated {formatRelative(s.readAt)}
              </span>
            </div>
          )
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Button icon={<SendIcon size={18} />} onClick={onSend} disabled={!s?.deployed}>
          Send
        </Button>
        <Button
          variant="secondary"
          icon={<ReceiveIcon size={18} />}
          onClick={() => setReceiveOpen(true)}
          disabled={!s?.address}
        >
          Receive
        </Button>
      </div>

      {s?.supported && s.address && !s.deployed && <ActivationCard status={s} onActivate={onActivate} />}

      {s?.deployed && (
        <section aria-labelledby="more-h" className="flex flex-col gap-2">
          <h2 id="more-h" className="t-strong">
            Your account
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenApp("#sessions")}>
              Sessions
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onOpenApp("#keys")}>
              Keys & recovery
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onOpenApp("#migrate")}>
              Move in
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onOpenApp("#privacy")}>
              Private balance
            </Button>
          </div>
          <p className="t-small text-muted">
            Payments are signed with your quantum-safe owner key. A site with a session can pay within its limits
            without asking.
          </p>
        </section>
      )}

      <Sheet open={receiveOpen} title="Receive" onClose={() => setReceiveOpen(false)}>
        {s?.address && <ReceiveBody status={s} address={s.address} networkName={net.name} />}
        <div className="mt-4">
          <Button variant="secondary" block onClick={() => setReceiveOpen(false)}>
            Close
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function ReceiveBody({
  status,
  address,
  networkName,
}: {
  status: AccountStatus;
  address: string;
  networkName: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="t-small self-start text-muted">
        Your address on {networkName}. Send only on the network shown.
        {!status.deployed && " Not created yet: you can already receive here."}
      </p>
      <QrCode value={address} label={`QR code of your address ${groupedAddress(address)}`} />
      <p className="t-mono w-full rounded-md bg-surface p-3 text-center break-all" data-testid="receive-address">
        {groupedAddress(address)}
      </p>
      <Button
        block
        icon={copied ? <CheckIcon size={16} /> : undefined}
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy address"}
      </Button>
      <p className="sr-only" aria-live="polite">
        {copied ? "Address copied" : ""}
      </p>
    </div>
  );
}

function ActivationCard({ status, onActivate }: { status: AccountStatus; onActivate: () => void }) {
  return (
    <Card className="border-brand" heading={status.activation ? "Creating your account…" : "Create your account"}>
      <p className="t-small text-muted">
        {status.activation
          ? "Waiting for the network to confirm. This takes a few seconds."
          : "Your setup key creates the account on the network. Until then it can receive but not pay."}
      </p>
      {!status.activation && (
        <div className="mt-3">
          <Button block onClick={onActivate}>
            Create account
          </Button>
        </div>
      )}
    </Card>
  );
}

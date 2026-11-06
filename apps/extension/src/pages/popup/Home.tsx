import { useState } from "react";
import { SHARED_DEVNET } from "../../shared/build";
import { getNetwork } from "../../shared/chains";
import { sharedUi } from "../lib/boot";
import type { WalletState } from "../../shared/types";
import type { AccountStatus } from "../../shared/views";
import {
  AddressChip,
  Button,
  Card,
  CheckIcon,
  FuelIcon,
  LimitMeter,
  QrCode,
  ReceiveIcon,
  RefreshIcon,
  RiskBanner,
  SendIcon,
  Sheet,
  Skeleton,
} from "../../ui";
import { formatRelative, formatUsd, groupedAddress } from "../../ui/format";
import { call } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth, usdOf } from "../lib/money";
import { openFullApp as openApp } from "./PopupApp";

export function Home({
  state,
  onSend,
  onActivate,
  onOpenApp,
}: {
  state: WalletState;
  onSend: (prefill?: { to: string }) => void;
  onActivate: () => void;
  onOpenApp: () => void;
}) {
  const chainId = state.settings.selectedChainId;
  const net = getNetwork(chainId);
  const status = useAsync(() => call("account:status", { chainId }), [chainId]);
  const bucket = useAsync(() => call("wallet:bucket"), [chainId]);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const queued = useAsync(
    async () => (await call("vault:queue", { chainId }).catch(() => [])).filter((q) => q.state === "pending"),
    [chainId],
  );
  const s = status.data;
  usePoll(() => Promise.all([status.reload(), bucket.reload()]), 3000, Boolean(s?.activation && !s.deployed));

  return (
    <div className="flex flex-col gap-4 p-4">
      {!state.setup.completedAt && (
        <RiskBanner
          level="info"
          title="Finish setting up"
          body="A few steps are left."
          action={{ label: "Continue setup", onClick: onOpenApp }}
        />
      )}
      {s?.frozen && <RiskBanner level="limit" title="Everyday spending is paused" body="Your phone can resume it." />}
      {s?.bunker && (
        <RiskBanner
          level="danger"
          title="Lockdown is on."
          body="Everyday spending is off until the Vault issues a new everyday key."
          action={{ label: "Open Security", onClick: () => openApp("#security") }}
        />
      )}
      {s?.deployed && !s.recoverySigner && (
        <RiskBanner
          level="info"
          title="Add a Recovery key before you keep real money here."
          body="It replaces your Vault if your phone is lost."
          action={{ label: "Set up", onClick: () => openApp("#security") }}
        />
      )}
      {(queued.data?.length ?? 0) > 0 && (
        <RiskBanner
          level="vault"
          title={`${queued.data!.length} change${queued.data!.length > 1 ? "s" : ""} scheduled: ${queued.data![0]!.title}`}
          action={{ label: "Review", onClick: () => openApp("#pending") }}
        />
      )}

      <section aria-labelledby="balance-h">
        <div className="flex items-center justify-between">
          <h2 id="balance-h" className="t-small text-muted">
            Balance on {net.name}
          </h2>
          <button
            type="button"
            onClick={() => void Promise.all([status.reload(), bucket.reload()])}
            aria-label="Refresh balance"
            className="grid size-8 place-items-center rounded-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            <RefreshIcon size={16} />
          </button>
        </div>
        {s && !s.error ? (
          <>
            <p className="t-display mt-0.5" data-testid="balance">
              {eth(s.accountWei, 4).replace(" ETH", "")} <span className="t-title text-muted">ETH</span>
            </p>
            {s.ethUsdPrice > 0 && <p className="t-small text-muted">{usdOf(s.accountWei, s.ethUsdPrice)}</p>}
          </>
        ) : status.error || s?.error ? null : (
          <Skeleton className="mt-1 h-[34px] w-40" label="Loading balance" />
        )}
        {status.error || s?.error ? (
          <p role="status" className="t-small mt-1 text-limit">
            Can't reach the network right now.{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => void status.reload()}>
              Retry
            </button>
          </p>
        ) : (
          s && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <AddressChip address={s.address} chain={net.accountKind} />
              <span className="t-small text-muted">
                {s.deployed ? "Active" : "Not activated yet"} · updated {formatRelative(s.readAt)}
              </span>
            </div>
          )
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Button icon={<SendIcon size={18} />} onClick={() => onSend()} disabled={!s?.deployed}>
          Send
        </Button>
        <Button variant="secondary" icon={<ReceiveIcon size={18} />} onClick={() => setReceiveOpen(true)}>
          Receive
        </Button>
      </div>

      {s && !s.deployed && <ActivationCard status={s} onActivate={onActivate} />}

      {SHARED_DEVNET && sharedUi && s && !s.error && (
        <sharedUi.FaucetCard
          chainId={chainId}
          targets={[
            { label: "Fee tank", address: s.tank },
            { label: "Account", address: s.address },
          ]}
          onFunded={() => setTimeout(() => void status.reload(), 4000)}
        />
      )}

      <section aria-labelledby="everyday-h" className="flex flex-col gap-2">
        <h2 id="everyday-h" className="t-strong">
          Everyday spending
        </h2>
        {bucket.data ? (
          bucket.data.source === "none" ? (
            <LimitMeter
              capUsd={bucket.data.capUsd}
              usedUsd={0}
              perTxMaxUsd={bucket.data.perTxMaxUsd}
              state="none"
              noneBody={
                s?.supported === false
                  ? (s.unsupportedReason ?? "Nothing is enforced on this network yet.")
                  : `Your ${formatUsd(bucket.data.capUsd)} limit (up to ${formatUsd(bucket.data.perTxMaxUsd)} per payment) starts when you activate your account.`
              }
            />
          ) : (
            <LimitMeter
              capUsd={bucket.data.capUsd}
              usedUsd={bucket.data.usedUsd}
              perTxMaxUsd={bucket.data.perTxMaxUsd}
              {...(bucket.data.frozen ? { state: "paused" as const } : {})}
              {...(bucket.data.nextRefill
                ? { nextRefill: { usd: bucket.data.nextRefill.usd, at: new Date(bucket.data.nextRefill.at) } }
                : {})}
            />
          )
        ) : bucket.error ? (
          <p className="t-small text-limit">Can't read your daily limit right now.</p>
        ) : (
          <Skeleton className="h-[120px] w-full" label="Loading daily limit" />
        )}
        <p className="t-small text-muted">Bigger payments ask your phone.</p>
      </section>

      {s?.deployed && <FeeTankRow status={s} onTopUp={() => onSend({ to: s.tank })} />}

      <Sheet open={receiveOpen} title="Receive" onClose={() => setReceiveOpen(false)}>
        {s && <ReceiveBody status={s} networkName={net.name} kind={net.accountKind} />}
        <div className="mt-4">
          <Button variant="secondary" block onClick={() => setReceiveOpen(false)}>
            Close
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function ReceiveBody({ status, networkName, kind }: { status: AccountStatus; networkName: string; kind: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="t-small self-start text-muted">
        Your address on {networkName} ({kind}). Send only on the network shown.
        {!status.deployed && " Not activated yet: you can already receive here."}
      </p>
      <QrCode value={status.address} label={`QR code of your address ${groupedAddress(status.address)}`} />
      <p className="t-mono w-full rounded-md bg-surface p-3 text-center break-all" data-testid="receive-address">
        {groupedAddress(status.address)}
      </p>
      <Button
        block
        icon={copied ? <CheckIcon size={16} /> : undefined}
        onClick={() => {
          void navigator.clipboard?.writeText(status.address).then(() => {
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
  if (!status.supported) return null;
  return (
    <Card className="border-brand" heading={status.activation ? "Activating your account…" : "Activate your account"}>
      <p className="t-small text-muted">
        {status.activation
          ? "Waiting for the network to confirm. This takes a few seconds."
          : "Activation puts your daily limit on the network. Until then your account can receive but not pay."}
      </p>
      {!status.activation && (
        <div className="mt-3">
          <Button block onClick={onActivate}>
            Activate account
          </Button>
        </div>
      )}
    </Card>
  );
}

function FeeTankRow({ status, onTopUp }: { status: AccountStatus; onTopUp: () => void }) {
  const low = BigInt(status.tankWei) < 2_000_000_000_000_000n;
  return (
    <section aria-labelledby="tank-h" className="flex items-center gap-3 rounded-md border border-line p-3">
      <span className={low ? "text-limit" : "text-muted"}>
        <FuelIcon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="tank-h" className="t-strong">
          Fee tank <span className="font-normal text-muted">{eth(status.tankWei, 4)}</span>
        </h2>
        <p className="t-small text-muted">
          {low ? "Low: top it up so everyday payments keep working." : "Pays network fees for everyday payments."}
        </p>
      </div>
      <Button size="sm" variant="secondary" onClick={onTopUp}>
        Top up
      </Button>
    </section>
  );
}

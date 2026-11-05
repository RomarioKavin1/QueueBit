import { useState } from "react";
import { getNetwork } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import {
  AddressChip,
  Button,
  LimitMeter,
  ReceiveIcon,
  RefreshIcon,
  RiskBanner,
  SendIcon,
  Sheet,
  Skeleton,
} from "../../ui";
import { formatAmount, formatRelative, groupedAddress } from "../../ui/format";
import { call } from "../lib/api";
import { useAsync } from "../lib/hooks";

export function Home({ state, onSend, onOpenApp }: { state: WalletState; onSend: () => void; onOpenApp: () => void }) {
  const chainId = state.settings.selectedChainId;
  const net = getNetwork(chainId);
  const account = state.accounts!.everyday;
  const balance = useAsync(() => call("wallet:balance", { chainId }), [chainId, account]);
  const bucket = useAsync(() => call("wallet:bucket"), [chainId, state.setup.dailyLimitUsd, state.setup.perPaymentUsd]);
  const [receiveOpen, setReceiveOpen] = useState(false);

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
      <RiskBanner
        level="limit"
        title="No Vault yet: there is no daily limit on this account."
        body="Pairing your phone as the Vault arrives in the next update. Until then, keep only test money here."
      />

      <section aria-labelledby="balance-h">
        <div className="flex items-center justify-between">
          <h2 id="balance-h" className="t-small text-muted">
            Balance on {net.name}
          </h2>
          <button
            type="button"
            onClick={() => void balance.reload()}
            aria-label="Refresh balance"
            className="grid size-8 place-items-center rounded-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            <RefreshIcon size={16} />
          </button>
        </div>
        {balance.data ? (
          <p className="t-display mt-0.5" data-testid="balance">
            {formatAmount(balance.data.wei, balance.data.decimals)}{" "}
            <span className="t-title text-muted">{balance.data.symbol}</span>
          </p>
        ) : balance.error ? null : (
          <Skeleton className="mt-1 h-[34px] w-40" label="Loading balance" />
        )}
        {balance.error && !balance.data ? (
          <p role="status" className="t-small mt-1 text-limit">
            Can't reach the network right now.{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => void balance.reload()}>
              Retry
            </button>
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <AddressChip address={account} chain={net.accountKind} />
            {balance.data && (
              <span className="t-small text-muted">Updated {formatRelative(balance.data.fetchedAt)}</span>
            )}
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Button icon={<SendIcon size={18} />} onClick={onSend}>
          Send
        </Button>
        <Button variant="secondary" icon={<ReceiveIcon size={18} />} onClick={() => setReceiveOpen(true)}>
          Receive
        </Button>
      </div>

      <section aria-labelledby="everyday-h" className="flex flex-col gap-2">
        <h2 id="everyday-h" className="t-strong">
          Everyday spending
        </h2>
        {bucket.data ? (
          <LimitMeter
            capUsd={bucket.data.capUsd}
            usedUsd={bucket.data.usedUsd}
            perTxMaxUsd={bucket.data.perTxMaxUsd}
            {...(bucket.data.nextRefill
              ? { nextRefill: { usd: bucket.data.nextRefill.usd, at: new Date(bucket.data.nextRefill.at) } }
              : {})}
            previewNote={
              bucket.data.source === "placeholder"
                ? "Preview: the limit you chose. It starts protecting you once your Vault is paired."
                : undefined
            }
          />
        ) : (
          <Skeleton className="h-[120px] w-full" label="Loading daily limit" />
        )}
        <p className="t-small text-muted">Bigger payments will ask your phone.</p>
      </section>

      <Sheet open={receiveOpen} title="Receive" onClose={() => setReceiveOpen(false)}>
        <p className="t-small text-muted">
          Your address on {net.name} ({net.accountKind}). Send only on the network shown.
        </p>
        <p className="t-mono mt-3 rounded-md bg-surface p-3 break-all" data-testid="receive-address">
          {groupedAddress(account)}
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" block onClick={() => setReceiveOpen(false)}>
            Close
          </Button>
          <Button block onClick={() => void navigator.clipboard?.writeText(account)}>
            Copy address
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

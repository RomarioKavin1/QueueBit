import { useState } from "react";
import type { PqEverydayView } from "../../shared/views";
import { Button, RiskBanner, Sheet, ShieldIcon, TextField } from "../../ui";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { eth, parseEth } from "../lib/money";
import { Row, SheetButtons } from "./Security";
import { startVault } from "./vaultStart";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Security › Quantum-safe everyday key (LeanPool). One row that says where things stand and offers the one next step:
 * set up, approve on the phone, top up, or switch keys. The set-up sheet says what changes and what you trust, before
 * any button.
 */
export function QuantumSafeRow({ disabled }: { disabled: boolean }) {
  const view = useAsync(() => call("pq:status", {}), []);
  const [sheet, setSheet] = useState<"setup" | "topup" | "off" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = view.data;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  if (!v) return null;
  const { value, detail } = describe(v);
  const action =
    v.state === "off" ? (
      <Button size="sm" variant="secondary" disabled={disabled || busy || !v.nodeOk} onClick={() => setSheet("setup")}>
        Turn on
      </Button>
    ) : v.state === "awaiting-vault" ? (
      <Button
        size="sm"
        variant="vault"
        disabled={disabled || busy}
        onClick={() => run(() => startVault({ type: "setPQHotSigner", signer: v.signer! }))}
      >
        Approve on phone
      </Button>
    ) : v.state === "on" && v.balanceWei && BigInt(v.balanceWei) < BigInt(v.minBalanceWei) * 2n ? (
      <Button size="sm" variant="secondary" disabled={disabled || busy} onClick={() => setSheet("topup")}>
        Top up
      </Button>
    ) : v.state === "on" ? (
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await call("pq:setPreferred", { preferred: !v.preferred });
            await view.reload();
          })
        }
      >
        {v.preferred ? "Use regular key" : "Use quantum-safe key"}
      </Button>
    ) : undefined;

  return (
    <>
      <Row
        icon={<ShieldIcon size={20} />}
        tone={v.state === "on" && v.active ? "safe" : "brand"}
        name="Quantum-safe everyday key"
        value={value}
        {...(detail ? { detail } : {})}
        {...(action ? { action } : {})}
      />
      {error && <RiskBanner level="danger" title={error} />}
      {v.state === "on" && (
        <div className="-mt-1 flex justify-end gap-3 px-1">
          <button
            type="button"
            className="t-small text-muted underline underline-offset-2"
            onClick={() => setSheet("topup")}
          >
            Top up its fee balance
          </button>
          <button
            type="button"
            className="t-small text-muted underline underline-offset-2"
            onClick={() => setSheet("off")}
          >
            Remove from account
          </button>
        </div>
      )}
      <SetupSheet
        open={sheet === "setup"}
        onClose={() => setSheet(null)}
        onReady={async (signer) => {
          setSheet(null);
          await startVault({ type: "setPQHotSigner", signer });
        }}
      />
      <TopUpPqSheet open={sheet === "topup"} onClose={() => setSheet(null)} onDone={() => void view.reload()} />
      <Sheet open={sheet === "off"} title="Remove the quantum-safe key" onClose={() => setSheet(null)}>
        <div className="flex flex-col gap-3">
          <p className="t-body">
            Your phone approves removing it from your account. Everyday payments then use your regular everyday key
            only. To stop using it for a while instead, choose "Use regular key": that needs no phone.
          </p>
          <SheetButtons onBack={() => setSheet(null)}>
            <Button
              block
              variant="vault"
              loading={busy}
              onClick={() => run(() => startVault({ type: "setPQHotSigner", signer: ZERO }))}
            >
              Approve on phone
            </Button>
          </SheetButtons>
        </div>
      </Sheet>
    </>
  );
}

/** One line for where it stands, and one for what it means right now. */
export function describe(v: PqEverydayView): { value: string; detail?: string } {
  switch (v.state) {
    case "unavailable":
      return { value: "Not available here", ...(v.reason ? { detail: v.reason } : {}) };
    case "off":
      return {
        value: "Off · everyday payments use a classical key",
        detail: v.nodeOk
          ? "Sign everyday payments with a post-quantum key, under the same daily limit."
          : "LeanPool isn't answering right now, so it can't be set up.",
      };
    case "awaiting-vault":
      return {
        value: `Ready · key …${v.vkLast8} · waiting for your phone`,
        detail: "Your phone approves adding it to your account. Until then, payments use your regular everyday key.",
      };
    case "on": {
      const bal = v.balanceWei ? ` · fee balance ${eth(v.balanceWei, 4)}` : "";
      if (!v.preferred)
        return {
          value: `Installed · not in use${bal}`,
          detail: "Payments use your regular everyday key (your choice).",
        };
      if (!v.nodeOk) {
        return {
          value: `On · key …${v.vkLast8}${bal}`,
          detail: "LeanPool isn't answering: payments use your regular everyday key until it's back.",
        };
      }
      if (!v.active) {
        return {
          value: `On · key …${v.vkLast8}${bal}`,
          detail: "Its fee balance is low: payments use your regular everyday key until you top it up.",
        };
      }
      return {
        value: `On · key …${v.vkLast8}${bal}`,
        detail: "Everyday payments are signed with your quantum-safe key. No signature goes on-chain.",
      };
    }
  }
}

function SetupSheet({
  open,
  onClose,
  onReady,
}: {
  open: boolean;
  onClose: () => void;
  onReady: (signer: `0x${string}`) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet open={open} title="Make everyday payments quantum-safe" onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="pq-setup-sheet">
        <ul className="t-body flex list-disc flex-col gap-1.5 pl-5">
          <li>
            Everyday payments get signed with a <b>post-quantum key</b> (leanSPHINCS), made from your recovery phrase.
          </li>
          <li>
            A <b>LeanPool</b> node checks each signature and batches it; your account only checks the batch. No
            signature goes on-chain.
          </li>
          <li>Same daily limit, same allowed lists. Your Vault and Recovery keys don't change.</li>
        </ul>
        <p className="t-small text-muted">
          Two steps: QueueBit sets the key up on the network (your fee tank pays, about 0.03 ETH, which becomes the
          key's own fee balance), then your phone approves it.
        </p>
        <RiskBanner
          level="info"
          title="What you trust: the LeanPool node you use could approve a payment you didn't sign, but never more than your daily limit allows, the same bound as a leaked everyday key. Each batch carries a proof anyone can check."
        />
        {error && <RiskBanner level="danger" title={error} />}
        <SheetButtons onBack={onClose}>
          <Button
            block
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const v = await call("pq:prepare", {});
                if (!v.signer) throw new Error("Setup didn't finish.");
                await onReady(v.signer);
              } catch (e) {
                setError(
                  e instanceof UiCallError ? e.message : e instanceof Error ? e.message : "Something went wrong.",
                );
                setBusy(false);
              }
            }}
          >
            Set up
          </Button>
        </SheetButtons>
      </div>
    </Sheet>
  );
}

function TopUpPqSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("0.02");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const wei = parseEth(amount);
  return (
    <Sheet open={open} title="Top up the quantum-safe key's fee balance" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="t-body">
          The quantum-safe key pays its own network fees (about 0.0007 ETH a payment). This moves ETH from your account
          to its fee balance.
        </p>
        <p className="t-small text-muted">
          It's an everyday payment: it counts against your daily limit and needs no phone. The ETH goes through your fee
          tank first.
        </p>
        <TextField
          label="Amount (ETH)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value.trim());
            setDone(null);
            setError(null);
          }}
          error={amount && !wei ? "Enter an amount like 0.02." : undefined}
        />
        {error && <RiskBanner level="danger" title={error} />}
        {done && <p className="t-small text-safe">{done}</p>}
        <SheetButtons onBack={onClose}>
          <Button
            block
            loading={busy}
            disabled={!wei || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await call("pq:topUp", { amountWei: wei!.toString() });
                setDone(`Done. Fee balance now ${eth(r.balanceWei, 4)}.`);
                onDone();
              } catch (e) {
                setError(e instanceof UiCallError ? e.message : "Something went wrong.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Top up {wei ? eth(wei, 6) : ""}
          </Button>
        </SheetButtons>
      </div>
    </Sheet>
  );
}

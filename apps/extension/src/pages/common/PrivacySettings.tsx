import { useState } from "react";
import { LOCAL_DEVNET } from "../../shared/build";
import { Button, Card, RiskBanner, TextField } from "../../ui";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";

/**
 * Settings › Private connection (ux-spec §3.13): the Anon-RPC toggle (default on), with the honest status. Where no
 * Anon-RPC worker exists (the devnet) or this build has none, the toggle is shown but unavailable, with why; turning
 * it off asks for explicit consent.
 */
export function PrivateConnectionSection({ chainId, enabled }: { chainId: number; enabled: boolean }) {
  const st = useAsync(() => call("privacy:connection", { chainId }), [chainId, enabled]);
  const [confirmOff, setConfirmOff] = useState(false);
  const s = st.data;
  const unavailable = s ? !s.available : true;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="anon-h" data-testid="settings-private-connection">
      <h2 id="anon-h" className="t-small font-semibold tracking-wide text-muted uppercase">
        Private connection (Anon-RPC)
      </h2>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={enabled && !unavailable}
          disabled={unavailable}
          aria-describedby="anon-desc"
          onChange={(e) => {
            if (e.target.checked) void call("settings:update", { anonRpc: true });
            else setConfirmOff(true);
          }}
        />
        <span>
          <span className="t-strong">Use a private connection</span>
          <span id="anon-desc" className="t-small block text-muted">
            Hides your IP from the network provider. The provider still sees what you ask. About 1.5 s slower per
            request.
          </span>
        </span>
      </label>
      {s && unavailable && (
        <p className="t-small text-muted" data-testid="anon-unavailable">
          Unavailable: {s.reason}
        </p>
      )}
      {confirmOff && (
        <RiskBanner
          level="limit"
          title="Turn the private connection off?"
          body="The network provider will see your IP address with every request, including your private balance's."
          action={{
            label: "Turn it off",
            onClick: () => {
              setConfirmOff(false);
              void call("settings:update", { anonRpc: false });
            },
          }}
          dismissible
          onDismiss={() => setConfirmOff(false)}
        />
      )}
    </section>
  );
}

/**
 * Settings › Private balance network: where Privacy Pools and its fee payer (PoolPayer) live. Fixed on every network
 * QueueBit ships; the local devnet's pool is deployed per run, so a local-devnet build lets it be entered here (it is
 * checked on chain before it is saved).
 */
export function PrivacyNetworkSection({ chainId }: { chainId: number }) {
  const view = useAsync(() => call("privacy:view", { chainId }), [chainId]);
  const cfg = view.data?.config;
  const editable = LOCAL_DEVNET && chainId === 1337;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ entrypoint: "", pool: "", poolPayer: "", deployBlock: "", sidecarUrl: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const start = () => {
    setF({
      entrypoint: cfg?.entrypoint ?? "",
      pool: cfg?.pool ?? "",
      poolPayer: cfg?.poolPayer ?? "",
      deployBlock: cfg?.deployBlock ?? "",
      sidecarUrl: cfg?.sidecarUrl ?? "",
    });
    setOpen(true);
    setSaved(false);
  };
  return (
    <section className="flex flex-col gap-2" aria-labelledby="ppnet-h" data-testid="settings-privacy-network">
      <h2 id="ppnet-h" className="t-small font-semibold tracking-wide text-muted uppercase">
        Private balance network
      </h2>
      {cfg ? (
        <Card className="bg-surface">
          <dl className="t-small grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Pool</dt>
            <dd className="t-mono break-all">{cfg.pool}</dd>
            <dt className="text-muted">Entrypoint</dt>
            <dd className="t-mono break-all">{cfg.entrypoint}</dd>
            <dt className="text-muted">Fee payer</dt>
            <dd className="t-mono break-all">{cfg.poolPayer}</dd>
            <dt className="text-muted">Fee payer&apos;s node</dt>
            <dd className="t-mono break-all">{cfg.sidecarUrl}</dd>
            <dt className="text-muted">History from block</dt>
            <dd>{cfg.deployBlock}</dd>
          </dl>
        </Card>
      ) : (
        <p className="t-small text-muted">
          {editable
            ? "No pool set for the local devnet yet."
            : "QueueBit has no Privacy Pools deployment for this network yet."}
        </p>
      )}
      {saved && (
        <p role="status" className="t-small text-safe">
          Saved and checked on chain.
        </p>
      )}
      {editable && !open && (
        <Button variant="secondary" onClick={start}>
          {cfg ? "Change devnet pool" : "Set devnet pool"}
        </Button>
      )}
      {editable && open && (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await call("privacy:saveConfig", { chainId, ...f });
              setOpen(false);
              setSaved(true);
              await view.reload();
            } catch (err) {
              setError(err instanceof UiCallError ? err.message : "Couldn't save.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField
            label="Entrypoint"
            value={f.entrypoint}
            onChange={(e) => setF({ ...f, entrypoint: e.target.value })}
          />
          <TextField label="Pool (ETH)" value={f.pool} onChange={(e) => setF({ ...f, pool: e.target.value })} />
          <TextField
            label="Fee payer (PoolPayer)"
            value={f.poolPayer}
            onChange={(e) => setF({ ...f, poolPayer: e.target.value })}
          />
          <TextField
            label="Pool deployed at block"
            inputMode="numeric"
            value={f.deployBlock}
            onChange={(e) => setF({ ...f, deployBlock: e.target.value })}
          />
          <TextField
            label="Fee payer's node (optional)"
            description="The alt-mempool node withdrawals are sent to. Default: the local staked lane."
            value={f.sidecarUrl}
            onChange={(e) => setF({ ...f, sidecarUrl: e.target.value })}
          />
          {error && <RiskBanner level="danger" title={error} />}
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" block loading={busy} loadingLabel="Checking on chain…">
              Save
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

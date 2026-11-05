import { ActivityIcon, AppsIcon, GlobeIcon, SendIcon } from "../../ui";
import { Button } from "../../ui";
import { hostOf, formatRelative } from "../../ui/format";
import { call } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { EmptyState, SoonBadge } from "../common/EmptyState";

export function SendTab() {
  return (
    <EmptyState
      icon={<SendIcon />}
      title="Sending arrives in the next update"
      body="Payments within your daily limit will go through instantly. Bigger ones will ask your phone."
    >
      <SoonBadge />
    </EmptyState>
  );
}

export function ActivityTab() {
  return (
    <EmptyState
      icon={<ActivityIcon />}
      title="No activity yet"
      body="Payments, sign-ins and Vault approvals will show here, step by step."
    />
  );
}

export function AppsTab() {
  const perms = useAsync(() => call("permissions:list"), []);
  const list = perms.data ?? [];
  return (
    <div className="p-4">
      <h2 className="t-strong">Connected sites</h2>
      <p className="t-small mb-3 text-muted">These sites can see your address. They still ask before every payment.</p>
      {perms.loading && !perms.data ? null : list.length === 0 ? (
        <EmptyState
          icon={<AppsIcon />}
          title="No sites connected"
          body="When a site asks to connect, you'll decide here in LEAKED."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Connected sites">
          {list.map((p) => (
            <li key={p.origin} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <span className="text-muted">
                <GlobeIcon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="t-strong truncate">{hostOf(p.origin)}</p>
                <p className="t-small text-muted">Connected {formatRelative(p.grantedAt)}</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Disconnect ${hostOf(p.origin)}`}
                onClick={async () => {
                  await call("permissions:revoke", { origin: p.origin });
                  await perms.reload();
                }}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

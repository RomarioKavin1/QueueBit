import { LogoMark, QrPlaceholder, ReasonCode, RiskBanner } from "../../ui";

/**
 * Vault approval hand-off (ux-spec §3.6, `#vault/<request>`). The request QR and the scan-back are milestone M4; this
 * page is a clearly marked placeholder that shows what would be asked, so the "Request Vault approval" button never
 * leads nowhere. Nothing is signed or sent from here.
 */
export function VaultPlaceholder() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const rules = (q.get("rules") ?? "").split(",").filter(Boolean);
  const rows: Array<[string, string | null]> = [
    ["Amount", q.get("amount") && `${q.get("amount")} (${q.get("usd") ?? ""})`],
    ["To", q.get("to")],
    ["Requested by", q.get("site")],
    ["Why your phone", q.get("why")],
  ];
  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto flex max-w-[640px] flex-col gap-5 px-6 py-8">
        <div className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="t-title">LEAKED</span>
        </div>
        <main className="flex flex-col gap-4 rounded-lg border border-line bg-bg p-6">
          <span className="t-small self-start rounded-sm bg-vault-bg px-2 py-0.5 font-semibold text-vault">
            Placeholder · arrives with the Vault app
          </span>
          <h1 className="t-title">Vault approval</h1>
          <RiskBanner
            level="vault"
            title="Vault approvals aren't available in this version"
            body="When they are, this page shows a code for your phone to scan. Your phone shows exactly what it is about to sign; you compare it with this screen. Nothing has been signed or sent."
          />
          <dl className="divide-y divide-line rounded-md border border-line">
            {rows
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:gap-4">
                  <dt className="t-strong sm:w-36">{k}</dt>
                  <dd className={`t-body text-muted ${k === "To" ? "break-all" : "break-words"}`}>{v}</dd>
                </div>
              ))}
          </dl>
          <div className="flex flex-col items-center gap-2">
            <QrPlaceholder label="Placeholder for the Vault request code (not available yet)" size={180}>
              Request code (coming soon)
            </QrPlaceholder>
          </div>
          {rules.length > 0 && (
            <details>
              <summary className="t-small cursor-pointer text-muted underline underline-offset-2">Details</summary>
              <div className="mt-2 flex flex-wrap gap-1">
                {rules.map((r) => (
                  <ReasonCode key={r} id={r} />
                ))}
              </div>
            </details>
          )}
          <p className="t-small text-muted">You can close this tab. Everyday payments within your limit still work.</p>
        </main>
      </div>
    </div>
  );
}

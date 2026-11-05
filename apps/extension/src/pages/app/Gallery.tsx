import { useState } from "react";
import {
  AddressChip,
  AmountInput,
  ApprovalCard,
  Button,
  Card,
  LimitMeter,
  QrPlaceholder,
  RiskBanner,
  Timeline,
  type RouteResult,
} from "../../ui";

const DEMO = "0x1234567890abcdef1234567890abcdef1234abcd";

/** `app.html#design`: every library component in its states, for visual review against ux-spec §6 (not linked from the UI). */
export function Gallery() {
  const [amount, setAmount] = useState("120");
  const routes: RouteResult[] = [
    { kind: "hot-ok" },
    { kind: "vault-cap" },
    { kind: "vault-timelock", thresholdUsd: 5000 },
    { kind: "frozen", resumes: "in 2 days" },
    { kind: "bunker" },
  ];
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-8 p-8">
      <h1 className="t-title">LEAKED components</h1>
      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="vault">Approve on phone</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="danger-outline">Connect anyway</Button>
          <Button variant="ghost">Ghost</Button>
          <Button loading loadingLabel="Securing…">
            Create
          </Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>
      <Section title="Risk banners">
        <div className="flex flex-col gap-2">
          <RiskBanner
            level="danger"
            title="Lockdown is on."
            body="Everyday spending is off until the Vault issues a new everyday key."
            action={{ label: "Open Security", onClick: () => {} }}
          />
          <RiskBanner level="limit" title="No Vault yet: there is no daily limit on this account." />
          <RiskBanner
            level="vault"
            title="1 change scheduled: Raise daily limit to $2,000, in 31 h."
            action={{ label: "Review", onClick: () => {} }}
          />
          <RiskBanner level="info" title="Add a Recovery key before you keep real money here." dismissible />
        </div>
      </Section>
      <Section title="Limit meter">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LimitMeter
            capUsd={500}
            usedUsd={42}
            perTxMaxUsd={200}
            nextRefill={{ usd: 42, at: new Date(Date.now() + 3 * 3600e3) }}
          />
          <LimitMeter capUsd={500} usedUsd={380} perTxMaxUsd={200} />
          <LimitMeter capUsd={500} usedUsd={490} perTxMaxUsd={200} />
          <LimitMeter
            capUsd={500}
            usedUsd={100}
            perTxMaxUsd={200}
            state="paused"
            pausedUntil={new Date(Date.now() + 86400e3)}
          />
          <LimitMeter capUsd={0} usedUsd={0} perTxMaxUsd={0} state="none" />
        </div>
      </Section>
      <Section title="Approval cards (route preview)">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {routes.map((r) => (
            <ApprovalCard
              key={r.kind}
              route={r}
              amountUsd={120}
              remainingUsd={458}
              ruleIds={["ROUTE-" + r.kind.toUpperCase()]}
              lane="standard"
              maxFeeText="$0.40"
            />
          ))}
        </div>
      </Section>
      <Section title="Address chip, amount input">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <AddressChip address={DEMO} />
            <AddressChip address={DEMO} name="Sam" badge="new" />
            <AddressChip address={DEMO} chain="Native account" />
          </div>
          <div className="max-w-[360px]">
            <AmountInput
              asset={{ symbol: "USDC" }}
              balance="1500"
              fiatRate={1}
              perTxMaxUsd={200}
              value={amount}
              onChange={setAmount}
            />
          </div>
        </div>
      </Section>
      <Section title="Timeline, QR placeholder, card">
        <div className="flex flex-wrap gap-6">
          <Timeline
            label="Steps"
            steps={[
              { label: "Check approval", status: "done" },
              { label: "Pay network fee", status: "active" },
              { label: "Swap", status: "pending" },
              { label: "Refund", status: "failed" },
            ]}
          />
          <QrPlaceholder label="QR placeholder">Animated QR (M4)</QrPlaceholder>
          <Card heading="Card" className="max-w-[240px]">
            <p className="t-small text-muted">1 px border, no shadow, 12 px padding.</p>
          </Card>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="t-strong mb-3 text-muted">{title}</h2>
      {children}
    </section>
  );
}

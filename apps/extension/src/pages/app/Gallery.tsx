import { useState } from "react";
import { AddressChip, AmountInput, Button, Card, RiskBanner, Timeline } from "../../ui";

const DEMO = "0x1234567890abcdef1234567890abcdef1234abcd";

/** `app.html#design`: every library component in its states, for visual review against ux-spec §6 (not linked from the UI). */
export function Gallery() {
  const [amount, setAmount] = useState("120");
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-8 p-8">
      <h1 className="t-title">QueueBit components</h1>
      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="owner">Sign with owner key</Button>
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
            title="Your owner key is near its safe limit"
            body="120 signatures left. Add a new owner key before it runs out."
            action={{ label: "Keys & recovery", onClick: () => {} }}
          />
          <RiskBanner level="limit" title="Your account can't cover this and its network fee." />
          <RiskBanner
            level="owner"
            title="Your session with this site doesn't cover this"
            body="Over the session's daily ETH limit."
          />
          <RiskBanner level="info" title="Back up your words before you keep real money here." dismissible />
        </div>
      </Section>
      <Section title="Address chip, amount input">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <AddressChip address={DEMO} />
            <AddressChip address={DEMO} name="Sam" badge="new" />
            <AddressChip address={DEMO} chain="Quantum-safe account" />
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
      <Section title="Timeline, card">
        <div className="flex flex-wrap gap-6">
          <Timeline
            label="Steps"
            steps={[
              { label: "Signature checked", status: "done" },
              { label: "Batch recorded", status: "active" },
              { label: "Sent", status: "pending" },
              { label: "Done", status: "failed" },
            ]}
          />
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

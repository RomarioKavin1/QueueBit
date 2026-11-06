import type { SendPreview } from "../../shared/views";
import { ShieldIcon } from "../../ui";
import { eth } from "./money";

/** "Network fee ≈ … · from …": who pays depends on the key that signs (fee tank, account, or the quantum-safe key). */
export function feeLine(p: SendPreview | null | undefined): string | undefined {
  if (!p?.feeWei) return undefined;
  const from =
    p.signingKey?.kind === "quantum-safe"
      ? "from your quantum-safe key's fee balance"
      : p.backend === "4337"
        ? "from your account"
        : "from your fee tank";
  return `Network fee ≈ ${eth(p.feeWei)} · ${from}`;
}

/** Which key signs this everyday payment, when the quantum-safe key is set up (nothing otherwise). */
export function SigningKeyNote({ preview }: { preview: SendPreview | null | undefined }) {
  const k = preview?.signingKey;
  if (!k) return null;
  return k.kind === "quantum-safe" ? (
    <p className="t-small flex items-center gap-1.5 text-safe" data-testid="signing-key">
      <ShieldIcon size={14} />
      Quantum-safe: signed with your post-quantum key and checked by LeanPool.
    </p>
  ) : (
    <p className="t-small text-muted" data-testid="signing-key">
      {k.fallback}
    </p>
  );
}

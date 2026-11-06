import type { VaultActionRequest } from "../../background/vaultActions";
import { call } from "../lib/api";

/** Builds a Vault request in the service worker and moves the full app to its hand-off page. */
export async function startVault(action: VaultActionRequest): Promise<void> {
  const rec = await call("vault:create", { action });
  location.hash = `#vault/${rec.id}`;
}

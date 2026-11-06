import { SHARED_DEVNET } from "../../shared/build";
import * as shared from "../common/SharedDevnet";

/**
 * The shared-devnet flavour's UI pieces (faucet, Settings › Shared devnet). Outside that flavour the module is a stub
 * (wxt.config.ts `sharedStub`) and every use sits behind `SHARED_DEVNET`, so a store build carries none of it.
 */
export const sharedUi: typeof shared | undefined = SHARED_DEVNET ? shared : undefined;

/** Before the first render: the shared-devnet flavour loads its checked network table (a no-op in other builds). */
export async function beforeRender(): Promise<void> {
  if (SHARED_DEVNET) await shared.ensureSharedDevnet();
}

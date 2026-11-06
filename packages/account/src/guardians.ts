import { encodeFunctionData, type Address } from "viem";
import { leanAccountAbi } from "./abi.js";
import { DEFAULT_RECOVERY_DELAY, guardianInit, type AccountDeployment } from "./create.js";
import type { Call } from "./tx.js";

/** ERC-7579 module type of GuardianRecovery. */
const EXECUTOR = 2n;

/**
 * Changing the guardians of an account that exists: an admin action (the calls target the account itself, so the
 * owner key signs them). GuardianRecovery keeps one guardian set per install, so a new set is a reinstall: uninstall
 * (when installed), then install with the new guardians. A reinstall starts a fresh set, so every recovery the old
 * guardians had started dies with it. No guardians: only the uninstall.
 */
export function setGuardiansCalls(
  d: AccountDeployment,
  account: Address,
  o: { installed: boolean; guardians: Address[]; threshold: number; delay?: number },
): Call[] {
  const distinct = new Set(o.guardians.map((g) => g.toLowerCase())).size;
  if (o.guardians.length && (o.threshold < 1 || o.threshold > distinct))
    throw new Error(`The threshold must be between 1 and the ${distinct} distinct guardian(s).`);
  const call = (data: `0x${string}`): Call => ({ to: account, value: 0n, data });
  const calls: Call[] = [];
  if (o.installed)
    calls.push(
      call(
        encodeFunctionData({
          abi: leanAccountAbi,
          functionName: "uninstallModule",
          args: [EXECUTOR, d.recovery, "0x"],
        }),
      ),
    );
  if (o.guardians.length)
    calls.push(
      call(
        encodeFunctionData({
          abi: leanAccountAbi,
          functionName: "installModule",
          args: [EXECUTOR, d.recovery, guardianInit(o.guardians, o.threshold, o.delay ?? DEFAULT_RECOVERY_DELAY)],
        }),
      ),
    );
  if (!calls.length) throw new Error("Nothing to change: no guardians now, none asked for.");
  return calls;
}

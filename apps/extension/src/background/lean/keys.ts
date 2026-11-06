import { KIND, ROLE, guardianRecoveryAbi, keystoreAbi } from "@queuebit/account";
import { getAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { NetworkDeployment } from "../../shared/chains";
import type { KeyView, RecoveryView } from "../../shared/views";

const KIND_NAMES: Record<number, string> = {
  [KIND.PQ]: "Quantum-safe key",
  [KIND.PASSKEY]: "Passkey",
  [KIND.P256]: "Device key",
  [KIND.ECDSA]: "Ordinary key",
  [KIND.EIP712]: "Browser wallet",
};

/** The keys on the account, as the keystore has them (Keys & recovery). */
export async function readKeys(
  client: PublicClient,
  d: NetworkDeployment,
  account: Address,
  ownerVk: Hex,
  nowSec: number,
): Promise<KeyView[]> {
  const [ids, keys] = await client.readContract({
    address: d.keystore,
    abi: keystoreAbi,
    functionName: "getKeys",
    args: [account],
  });
  return ids.map((id, i) => {
    const k = keys[i]!;
    const until = Number(k.validUntil);
    return {
      id,
      kind: KIND_NAMES[k.kind] ?? `Key type ${k.kind}`,
      quantumSafe: k.kind === KIND.PQ,
      admin: (k.roles & ROLE.ADMIN) !== 0,
      spend: (k.roles & ROLE.SPEND) !== 0,
      session: (k.roles & ROLE.SESSION) !== 0,
      weight: k.weight,
      ...(until ? { validUntil: until } : {}),
      expired: until !== 0 && until <= nowSec,
      perTxWei: k.perTxCap.toString(),
      isOwnerKey: k.kind === KIND.PQ && k.a.toLowerCase() === ownerVk.toLowerCase(),
      ...(k.kind === KIND.ECDSA || k.kind === KIND.EIP712 ? { address: `0x${k.a.slice(-40)}` as Address } : {}),
    };
  });
}

/** Whether each address is a guardian of the account (GuardianRecovery). */
export async function readGuardians(
  client: PublicClient,
  d: NetworkDeployment,
  account: Address,
  guardians: Address[],
): Promise<Array<{ address: Address; active: boolean }>> {
  return Promise.all(
    guardians.map(async (g) => ({
      address: g,
      active: await client
        .readContract({ address: d.recovery, abi: guardianRecoveryAbi, functionName: "isGuardian", args: [g, account] })
        .catch(() => false),
    })),
  );
}

/**
 * Recoveries guardians started on the account (GuardianRecovery `Approved` events), minus those executed or
 * cancelled. A recovery nobody here asked for is the thing to act on: the owner can cancel it before it is ready.
 */
export async function readRecoveries(
  client: PublicClient,
  d: NetworkDeployment,
  account: Address,
  fromBlock = 0n,
): Promise<RecoveryView[]> {
  const at = { address: d.recovery, args: { account }, fromBlock };
  const [approved, recovered, cancelled] = await Promise.all([
    client.getLogs({ ...at, event: getAbiItem({ abi: guardianRecoveryAbi, name: "Approved" }) }),
    client.getLogs({ ...at, event: getAbiItem({ abi: guardianRecoveryAbi, name: "Recovered" }) }),
    client.getLogs({ ...at, event: getAbiItem({ abi: guardianRecoveryAbi, name: "Cancelled" }) }),
  ]);
  const closed = new Set([...recovered, ...cancelled].map((l) => (l.args.id as Hex).toLowerCase()));
  const open = new Map<string, RecoveryView>();
  for (const l of approved) {
    const id = (l.args.id as Hex).toLowerCase();
    if (closed.has(id)) continue;
    open.set(id, {
      id: l.args.id as Hex,
      approvals: Number(l.args.approvals ?? 0),
      readyAt: Number(l.args.readyAt ?? 0n),
      lastGuardian: l.args.guardian as Address,
    });
  }
  return [...open.values()];
}

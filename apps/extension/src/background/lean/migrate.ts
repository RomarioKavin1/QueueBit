import {
  eoa7702Plan,
  execTransactionCall,
  initializeData,
  moveCalls,
  multiSendSafeTx,
  packSafeSignatures,
  readSource,
  saPlan,
  safeAbi,
  safeTxTypedData,
  sweepValue,
  upgradeCall,
  type Call,
  type MigrationSource,
} from "@queuebit/account";
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { NetworkDeployment } from "../../shared/chains";
import type { AccountPlan } from "./plan";
import { quoteLegacy, send7702, sendLegacy, waitLegacy } from "./legacy";

/**
 * Moving into the account ("Move to quantum-safe"): an ordinary address (EOA), a Safe, or another smart account.
 *
 * - EOA, move (default): each token to the account, then `createAccount` with the rest of the ETH (it creates the
 *   account if needed, else just funds it). The old key is left empty.
 * - EOA, keep the address (EIP-7702): the address delegates to LeanAccount with the owner key installed. Same address,
 *   ready for quantum-safe keys, not quantum-safe: the old key keeps working.
 * - Safe: one Safe transaction (MultiSend) moves every token and the ETH; the owners' keys sign it here and the setup
 *   key sends it.
 * - Smart account with an owner key and `execute(Call[])`: upgrades in place when it is a UUPS proxy (same address,
 *   the old key stops working), else moves like a Safe, sent by its owner key.
 * Keys imported for a move are used for that move only and never stored.
 */

export type MigrationKind = "eoa" | "safe" | "smart-account";

export type MigrationMode =
  "move" | "7702-delegate" | "7702-initialize" | "safe-move" | "account-upgrade" | "account-move";

export interface MigrationPlan {
  kind: MigrationKind;
  mode: MigrationMode;
  source: Address;
  /** Where the money ends up (the account, or the source itself for 7702 and upgrades). */
  destination: Address;
  /** The calls the source runs (an EOA sends one transaction per call). */
  calls: Call[];
  eth: bigint;
  tokens: MigrationSource["tokens"];
  warning?: string;
  steps: string[];
}

export const SAME_ADDRESS_WARNING =
  "Same address, ready for quantum-safe keys but not quantum-safe yet: the old key still works and can still move everything.";

export interface PlanOptions {
  kind: MigrationKind;
  /** EOA: move (default) or keep the address with 7702. */
  keepAddress?: boolean;
  /** Safe: its owners and threshold, and the owners whose keys were imported. */
  safe?: { owners: Address[]; threshold: number; signers: Address[] };
  /** Safe: the owners sign the SafeTx in their own wallets (no imported keys) and one of them sends it. */
  external?: boolean;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** What a move does (pure; reads nothing). */
export function planMigration(
  d: NetworkDeployment,
  target: AccountPlan,
  src: MigrationSource,
  o: PlanOptions,
): MigrationPlan {
  const tokens = src.tokens.filter((t) => t.balance > 0n);
  const base = { kind: o.kind, source: src.address, eth: src.eth, tokens };
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
  if (same(src.address, target.address)) throw new Error("That's this account already.");
  const tokenSteps = tokens.map((t) => `Send token ${short(t.token)} to your account`);

  if (o.kind === "eoa") {
    if (src.code.kind === "contract")
      throw new Error("This address is a contract: move it as a Safe or smart account.");
    if (o.keepAddress) {
      const m = eoa7702Plan(
        src.code.kind === "7702" ? `0xef0100${src.code.delegate.slice(2)}` : "0x",
        src.leanInitialized,
        d.implementation,
      );
      return {
        ...base,
        mode: m === "delegate" ? "7702-delegate" : "7702-initialize",
        destination: src.address,
        calls: [{ to: src.address, value: 0n, data: initializeData(d, target.options) }],
        warning: SAME_ADDRESS_WARNING,
        steps: [
          m === "delegate"
            ? "Turn this address into an account with your owner key (one transaction it pays for)"
            : "Add your owner key to this address (one transaction it pays for)",
        ],
      };
    }
    if (src.eth === 0n) throw new Error("This address has no ETH to pay the network fees of the move.");
    return {
      ...base,
      mode: "move",
      destination: target.address,
      calls: moveCalls(d, target.options, target.address, tokens, src.eth),
      steps: [...tokenSteps, "Send the rest of the ETH to your account (this also creates it if needed)"],
    };
  }

  if (src.code.kind !== "contract") throw new Error("There's no contract at this address.");

  if (o.kind === "safe") {
    if (!d.multiSend) throw new Error("This network has no MultiSend contract, so a Safe can't move here.");
    const s = o.safe;
    if (!s) throw new Error("Read the Safe's owners first.");
    const owners = new Set(s.owners.map((x) => x.toLowerCase()));
    const outsiders = s.signers.filter((x) => !owners.has(x.toLowerCase()));
    if (outsiders.length) throw new Error(`${short(outsiders[0]!)} isn't an owner of this Safe.`);
    const signers = new Set(s.signers.map((x) => x.toLowerCase()));
    if (!o.external && signers.size < s.threshold)
      throw new Error(`This Safe needs ${s.threshold} owner keys; ${signers.size} imported.`);
    if (src.eth === 0n && tokens.length === 0) throw new Error("This Safe holds nothing to move.");
    if (o.external)
      return {
        ...base,
        mode: "safe-move",
        destination: target.address,
        calls: moveCalls(d, target.options, target.address, tokens, src.eth),
        steps: [
          `${s.threshold} owner${s.threshold > 1 ? "s sign" : " signs"} one Safe transaction in their own wallet`,
          "A connected owner sends it: every token and all the ETH move to your account at once",
        ],
      };
    return {
      ...base,
      mode: "safe-move",
      destination: target.address,
      calls: moveCalls(d, target.options, target.address, tokens, src.eth),
      steps: [
        `${signers.size} owner key${signers.size > 1 ? "s" : ""} sign one Safe transaction`,
        "Your setup key sends it: every token and all the ETH move to your account at once",
      ],
    };
  }

  const m = saPlan(src.implementation, src.isUUPS, d.implementation);
  if (m === "upgrade") {
    return {
      ...base,
      mode: "account-upgrade",
      destination: src.address,
      calls: [upgradeCall(d, src.address, target.options)],
      steps: ["Its owner key upgrades it in place: same address, your owner key replaces the old one"],
    };
  }
  if (src.eth === 0n && tokens.length === 0) throw new Error("This account holds nothing to move.");
  return {
    ...base,
    mode: "account-move",
    destination: target.address,
    calls: moveCalls(d, target.options, target.address, tokens, src.eth),
    steps: ["Its owner key sends one transaction: every token and all the ETH move to your account"],
  };
}

/** An owner-operated smart account's batch entry point (LegacyAccount, SimpleAccount-style). */
export const ownedAccountAbi = parseAbi(["function execute((address to, uint256 value, bytes data)[] calls) payable"]);

export interface MigrationIo {
  client: PublicClient;
  chainId: number;
  d: NetworkDeployment;
  /** Runs `fn` with the setup key (Safe moves). */
  withSetupKey<T>(fn: (key: Hex) => Promise<T>): Promise<T>;
  /** Reported after every transaction sent. */
  onSent(step: { label: string; hash: Hex; from: Address }): Promise<void>;
}

/** Reads what a move needs about `address` (balances of the network's tokens included). */
export const readMigrationSource = (client: PublicClient, address: Address, tokens: Address[]) =>
  readSource(client, address, tokens);

export async function readSafe(client: PublicClient, safe: Address) {
  const [owners, threshold, nonce] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
  ]);
  return { owners: [...owners], threshold: Number(threshold), nonce };
}

/**
 * Runs a plan. `keys`: the imported private keys (the EOA's or smart account's owner key; a Safe's owner keys).
 * Every transaction is waited for before the next is sent. Returns the hashes sent.
 */
export async function runMigration(io: MigrationIo, plan: MigrationPlan, keys: Hex[]): Promise<Hex[]> {
  const sent: Hex[] = [];
  const send = async (label: string, from: Address, fn: () => Promise<Hex>) => {
    const hash = await fn();
    sent.push(hash);
    await io.onSent({ label, hash, from });
    if (!(await waitLegacy(io.client, hash))) throw new Error(`${label}: the transaction failed.`);
  };
  const key = keys[0];
  if (!key) throw new Error("Import the key first.");
  const from = privateKeyToAccount(key).address;

  switch (plan.mode) {
    case "7702-delegate":
      await send("Turn the address into an account", from, () =>
        send7702(io.client, key, io.chainId, io.d.implementation, plan.calls[0]!.data!),
      );
      break;
    case "7702-initialize":
      await send("Add the owner key", from, () => sendLegacy(io.client, key, io.chainId, plan.calls[0]!));
      break;
    case "move": {
      const steps = plan.calls.slice(0, -1);
      for (const c of steps) await send("Send a token", from, () => sendLegacy(io.client, key, io.chainId, c));
      const last = plan.calls[plan.calls.length - 1]!;
      // The last step sends what is left after its own fee (the token steps' fees are paid by now).
      const q = await quoteLegacy(io.client, from, { ...last, value: 0n });
      const balance = await io.client.getBalance({ address: from });
      const value = sweepValue(balance, q.gas, q.gasPrice);
      await send("Send the ETH", from, () => sendLegacy(io.client, key, io.chainId, { ...last, value }, q));
      break;
    }
    case "safe-move": {
      const safe = plan.source;
      const { nonce } = await readSafe(io.client, safe);
      const tx = multiSendSafeTx(io.d.multiSend!, plan.calls, nonce);
      const typed = safeTxTypedData(io.chainId, safe, tx);
      const sigs = await Promise.all(
        keys.map(async (k) => {
          const a = privateKeyToAccount(k);
          return { owner: a.address, signature: await a.signTypedData(typed) };
        }),
      );
      const exec = execTransactionCall(safe, tx, packSafeSignatures(sigs));
      await io.withSetupKey(async (setupKey) => {
        const setup = privateKeyToAccount(setupKey).address;
        await send("Move everything out of the Safe", setup, () => sendLegacy(io.client, setupKey, io.chainId, exec));
      });
      break;
    }
    case "account-upgrade":
    case "account-move": {
      const data = encodeFunctionData({
        abi: ownedAccountAbi,
        functionName: "execute",
        args: [plan.calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? "0x" }))],
      });
      await send(
        plan.mode === "account-upgrade" ? "Upgrade the account" : "Move everything out of the account",
        from,
        () => sendLegacy(io.client, key, io.chainId, { to: plan.source, data }),
      );
      break;
    }
  }
  return sent;
}

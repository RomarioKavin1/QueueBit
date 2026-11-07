/** Figure copy shared by the client plates and the server-rendered page (plain data, no client boundary). */

export const ANATOMY_LEGEND = [
  { name: "Account", sub: "Holds your funds · ERC-8286 + 7579" },
  { name: "Keystore", sub: "Which signatures count, and for what" },
  { name: "Spending hook", sub: "Daily limits and session expiry" },
  { name: "Guardian recovery", sub: "Reset after a delay you can cancel" },
] as const;

export const MOVE_STEPS = [
  { title: "Create a passkey", body: "It guards your quantum-safe owner key on this device." },
  { title: "Connect your wallet", body: "The one you use today. QueueBit reads what it holds." },
  { title: "Sign once", body: "Your current wallet approves a single move." },
  { title: "Everything moves", body: "Tokens and ETH arrive in your quantum-safe account." },
] as const;

/**
 * Gas per payment, from real receipts. QueueBit: docs/research/leanpool.md (`gas-compare.ts 20`, the average of 20
 * payments including the root posts and proof hashes). leanSPHINCS checked in the EVM: the same run's DirectPQWallet.
 * The rest: docs/writeups/pq-in-verify-benchmark.md (one transfer, the signature checked in the VERIFY frame).
 */
export const GAS_ROWS = [
  { name: "QueueBit, through LeanPool", sub: "0 signature bytes on chain", gas: 85_598, ours: true },
  { name: "SPHINCS- C13", sub: "cheapest of 8 measured on chain", gas: 250_682 },
  { name: "leanSPHINCS, checked on chain", sub: "the same key, without LeanPool", gas: 383_018 },
  { name: "SLH-DSA-SHA2-128s", sub: "FIPS 205", gas: 1_019_114 },
  { name: "Falcon-512", sub: "ETHFALCON", gas: 1_558_828 },
] as const;

export const GAS_NOTE =
  "Gas per payment from mined receipts on the alt-mempool devnet. QueueBit: the average of 20 payments, root posts and proof hashes included. Others: one transfer with the signature checked in the transaction.";

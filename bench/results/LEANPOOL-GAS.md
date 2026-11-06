# Gas: the everyday and Vault paths, with the quantum-safe everyday key (LeanPool)

All numbers are **measured on chain 1337** (EIP-8141 devnet, receipts), not estimated. Sources:
`contracts/devnet-tests/g1/last-run.json` (gate G1, local devnet) and `contracts/devnet-tests/leanpool/last-run.json`
(public devnet). VERIFY is the validation frame's execution gas; the flat mempool budget is 100,000.

| Path | Signature | VERIFY gas | Tx gas | Signature bytes on-chain | Mempool |
|---|---|---|---|---|---|
| Hot (everyday) payment, ECDSA | secp256k1 + fee tank | 45,772 | 323,099 (to a fresh address¹) · 129,880 (to a known one) | 65 + 65 | public |
| **Quantum-safe everyday payment (LeanPool)** | leanSPHINCS, verified off-chain | **61,449** | 344,849 (to a fresh address¹) | **0** (the 4,276-byte signature goes to the node) | ERC-8421 alt, unstaked |
| Vault, Path B (C13 checked in execution) | SPHINCS- C13 + payer ECDSA | 36,213 | 301,430 (tighten) · 493,050 (spend) | 3,688 + 65 | public |
| Vault, Path A (C13 in VERIFY) | SPHINCS- C13 | 151,701 | 291,492 | 3,688 | alt, staked, BUDGET-010 |
| Vault, Path A (leanSphincs-s) | leanSphincs-s | 84,465 | n/a (FrameSim/devnet measurement, IMPLEMENTATION-NOTES) | 4,164 | alt |

¹ A payment to a fresh address pays ~184k state gas for creating its account (`183,600` in the PQ receipt's SENDER
frame); compare the two fresh-address rows with each other.

**LeanPool's per-batch overhead**, paid by the aggregator, not the user: posting the batch root and writing it into each
sender's ring, 254,172 gas for the measured one-payment batch (the first write to a ring slot is the expensive part;
later batches reuse slots), plus attaching the STARK hash. Shared by every payment in the batch (up to 16).

**Against verifying a PQ signature in the EVM** (LeanPool's own baseline, `DirectPQWallet`, not ported: it verifies
LeanPool v1's keccak scheme, which QueueBit does not use): 383,018 gas per transfer and 5,684 signature bytes, against
LeanPool v2's 85,598 per transfer including the batch overhead amortized over 20 transfers
(`docs/research/leanpool.md`).

What this says: the quantum-safe everyday key costs about 16k more VERIFY gas than the ECDSA everyday key and roughly
the same per transaction, puts no signature on-chain, and fits the stock 100k budget without stake, which neither
C13 Path A (152k) nor an in-EVM PQ check can.

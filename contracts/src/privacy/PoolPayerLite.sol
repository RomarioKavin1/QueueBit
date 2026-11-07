// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolPayer} from "./PoolPayer.sol";
import {PrivacyPoolsTypes} from "./IPrivacyPools.sol";

/// @title PoolPayerLite
/// @notice `PoolPayer` with a cheap `pay` VERIFY frame, for mempools that cap the whole validation prefix at
///         EIP-8141 `MAX_VERIFY_GAS = 100,000` execution gas (the stock ERC-8421 sidecar: a hard-coded constant,
///         stake does not raise it). `PoolPayer.verify` spends ~298k gas, ~250k of it in the Groth16 check, so the
///         public sidecars refuse it.
///
///         Same frame layout, same checks, same at-cost settle/refund, except step 5: `verify` does NOT verify the
///         Groth16 proof. It still checks, read-only, everything that is cheap: the frame shape and budgets, the
///         processooor and the fee binding (`feeRecipient == this`, recipients, `fee >= quote(MAX_COST)`,
///         `fee <= withdrawn`), the context (`keccak(withdrawal, scope)` = the proof's public signal), the tree
///         depths, that the nullifier is unspent, that the state root is in the pool's root ring and that the ASP
///         root is the Entrypoint's latest. Then it approves payment. The proof is still fully verified on chain:
///         `pool.withdraw` checks it in the settle frame, so funds can never move without a valid proof.
///
///         Trade-off (the price of fitting in 100k): a transaction whose public signals pass the cheap checks but
///         whose proof is invalid gets PoolPayerLite's approval, `settle` reverts in `pool.withdraw`, `refund` is a
///         no-op, and PoolPayerLite pays the gas of the whole transaction without collecting a fee: up to its max
///         cost, since an invalid proof burns almost all of the settle frame's gas (public devnet, 2026-11-06:
///         settle 766,132 of 800,000, ~0.84M gas for the transaction). Everything the cheap checks read is public on
///         chain, so anyone can build such a transaction from a fresh, unfunded sender at no cost to themselves.
///         What does and does not bound it (measured on the public devnet's stock sidecar and ethrex):
///         - admission does NOT catch it: ethrex's simulation reports a reverted body frame as
///           `executionStatus: "reverted"` with `executionError: null`, and the sidecar rejects only on a failed
///           validation prefix, so the transaction would be admitted and mined (simulated, not submitted);
///         - reputation does NOT throttle it: ERC-7562 reputation compares opsSeen with opsIncluded, and a mined
///           transaction whose settle frame reverted counts as included;
///         - the operator bounds it: the loss is at most MAX_COST per transaction and the float in total, so keep
///           the float small (it only needs one MAX_COST), watch `Settled` against approvals, and refill or stop.
///         Use `PoolPayer` (proof in VERIFY, no such griefing) wherever the prefix budget allows it (a patched or
///         BUDGET-010 sidecar).
/// @dev    VERIFY-reachable code is `PoolPayer.verify` minus the verifier call, so it reads only immutables, the pool
///         (nullifier, root ring) and the Entrypoint (latest ASP root): ERC-7562 STORAGE-033 (read-only, non-entity
///         storage) requires PoolPayerLite to be staked in the ERC-8421 registry (`stake`).
contract PoolPayerLite is PoolPayer {
    constructor(Config memory c) payable PoolPayer(c) {}

    /// No Groth16 check in VERIFY: `pool.withdraw` verifies the proof in the settle frame (see the contract NatSpec).
    function _checkProof(PrivacyPoolsTypes.WithdrawProof calldata) internal view override {}
}

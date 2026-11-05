// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, FrameMode} from "@forshtat/hegota-support/contracts/Params.sol";
import {
    PrivacyPoolsTypes,
    IPrivacyPoolsPool,
    IPrivacyPoolsEntrypoint,
    IPrivacyPoolsWithdrawalVerifier,
    IERC8421StakingRegistry
} from "./IPrivacyPools.sol";

/// @title PoolPayer
/// @notice An at-cost EIP-8141 / ERC-8421 paymaster for Privacy Pools v1 (0xbow) withdrawals from the native-ETH
///         pool (plan `40-privacy-infra.md` §2). Verify-then-front: the `pay` VERIFY frame checks the Groth16 proof
///         and the pool's preconditions read-only and approves payment; the withdrawal runs in the execution body with
///         `processooor = PoolPayer`; the last frame refunds what the user pre-paid beyond the gas actually used.
///
///         Frame layout (v1: the sender is a fresh default-code EOA, the withdrawal recipient):
///           [0..]   VERIFY            optional expiry_verify, then only_verify(tx.sender) (default code, SECP256K1)
///           i       VERIFY  PAY       PoolPayer.verify(scope, withdrawal, proof, rootIndexHint)
///           i+1     DEFAULT           PoolPayer.settle(i)        (no proof bytes: read from frame i, FRAMEDATACOPY)
///           i+2..   SENDER            optional tail calls, only when the recipient is tx.sender
///           last    DEFAULT           PoolPayer.refund()
///
///         `withdrawal.data = abi.encode(FeeData{recipient, feeRecipient = PoolPayer, fee, refundRecipient})`
///         (Kohaku's `encodeFeeData` layout). The proof binds it through `context`.
///
///         At cost, enforced here (§7 rule 2): there is no fee parameter, margin or BPS anywhere. The user pre-pays
///         `fee >= quote(max cost)` out of the note and `refund()` returns `fee - cost`, where `cost` is a lower bound
///         of the protocol's charge (see `costEstimate`), so PoolPayer's balance can only stay flat or lose the
///         estimator's slack; it can never gain. The operator can move only the gas float it funded itself
///         (`withdrawFloat` excludes every user credit) and the stake.
///
///         The three mandatory rules of §2.2 / R14–R16:
///         1. the payout never reverts `settle`: a bounded-gas push, and on failure a credit in `claimable` that the
///            recipient pulls with `claim` — so a reverting recipient cannot make PoolPayer pay for a withdrawal that
///            never spends the note (free, repeatable griefing);
///         2. `verify` requires `refund()` to be the last frame (and the settle frame right after the pay frame), each
///            with enough gas that they cannot be starved;
///         3. the pay frame must carry state gas (APPROVE creates the fresh sender account).
/// @dev    VERIFY-reachable code (`verify`, `quote`, the frame-shape helpers) reads no `block.*`, `tx.gasprice`,
///         balances, `gasleft()` or transient storage and emits no events (IMPLEMENTATION-NOTES, FrameSim blind spots);
///         it reads only immutables, the pool, the Entrypoint and the verifier (STORAGE-032, staked payer). `GAS` is
///         used only as a `*CALL` operand. The halting reads of 50-devnet-review F6 (STATUS / *_GAS_USED of the running
///         frame) are never made: `settle` reads the STATUS of frame i (< its own), `refund` the gas of frames < itself.
contract PoolPayer is HegotaSupport {
    // ------------------------------------------------------------------------------------------- constants ------

    address public constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant MAX_TREE_DEPTH = 32;
    uint256 internal constant ROOT_HISTORY_SIZE = 64;

    /// Caps on the refund estimator's parameters (EIP-8141 / EIP-2780 values). Each parameter must be set at or below
    /// the devnet's measured value, so that `costEstimate` is a lower bound of the charge; the caps bound the damage
    /// of a mis-set deployment to a few thousand gas per withdrawal.
    uint256 public constant MAX_INTRINSIC_GAS = 21_000;
    uint256 public constant MAX_PER_FRAME_GAS = 475;
    /// EIP-7976 STANDARD_TOKEN_COST: the cheapest a calldata byte (a zero byte) can be.
    uint256 public constant MAX_GAS_PER_DATA_BYTE = 4;
    uint256 public constant MAX_REFUND_FRAME_GAS = 60_000;

    /// Execution gas forwarded to a payout recipient; a failure (revert or out of gas) becomes a `claimable` credit.
    uint256 public constant PAYOUT_GAS = 50_000;

    // ------------------------------------------------------------------------------------------------ types ------

    /// `withdrawal.data` (Kohaku `encodeFeeData` layout).
    struct FeeData {
        address recipient;
        address feeRecipient;
        uint256 fee;
        address refundRecipient;
    }

    struct Config {
        Devnet devnet;
        address entrypoint;
        address registry;
        address operator;
        /// `TxParam.MAX_COST` (ethrex-eip8141-tracer devnet: what APPROVE collects) or `TxParam.MAX_FEE` (EIP text,
        /// where it is the total budget). On the devnet `MAX_FEE` is per gas (50-devnet-review F5), so use MAX_COST.
        TxParam feeParam;
        // Refund estimator, lower bounds of the protocol's charge (each <= its MAX_* cap).
        uint64 intrinsicGas;
        uint64 perFrameGas;
        uint64 gasPerDataByte;
        uint64 refundFrameGas;
        // Frame budgets `verify` requires (anti-griefing / anti-starvation).
        uint64 minPayStateGas;
        uint64 minSettleGas;
        uint64 minSettleStateGas;
        uint64 minRefundGas;
        uint64 minRefundStateGas;
    }

    // ------------------------------------------------------------------------------------------------ state ------

    IPrivacyPoolsEntrypoint public immutable ENTRYPOINT;
    IERC8421StakingRegistry public immutable REGISTRY;
    TxParam public immutable FEE_PARAM;
    uint256 public immutable INTRINSIC_GAS;
    uint256 public immutable PER_FRAME_GAS;
    uint256 public immutable GAS_PER_DATA_BYTE;
    uint256 public immutable REFUND_FRAME_GAS;
    uint256 public immutable MIN_PAY_STATE_GAS;
    uint256 public immutable MIN_SETTLE_GAS;
    uint256 public immutable MIN_SETTLE_STATE_GAS;
    uint256 public immutable MIN_REFUND_GAS;
    uint256 public immutable MIN_REFUND_STATE_GAS;

    /// The vault / owner key that funds the float and manages the stake. It has no access to user funds.
    address public operator;

    /// Pull fallback: amounts a recipient's push could not take (reverting or gas-hungry `receive`).
    mapping(address => uint256) public claimable;
    /// Σ claimable: user money held by PoolPayer, never part of the float.
    uint256 public totalClaimable;

    /// The sig hash of the last transaction that ran `settle` (one settle per transaction).
    bytes32 public lastSettled;
    /// The transaction whose `refund` is due; `~sigHash` once refunded. Never zeroed (no SSTORE refunds, which would
    /// lower the protocol's charge below `costEstimate`).
    bytes32 public pendingSig;
    /// The pre-paid fee and refund recipient of `pendingSig` (one slot).
    uint96 public pendingFee;
    address public pendingRefundTo;

    // ----------------------------------------------------------------------------------------------- events ------

    event Settled(
        bytes32 indexed sigHash, uint256 indexed nullifierHash, address indexed recipient, uint256 paid, uint256 fee
    );
    event Refunded(bytes32 indexed sigHash, address indexed to, uint256 amount, uint256 costEstimate);
    event Credited(address indexed to, uint256 amount);
    event Claimed(address indexed from, address indexed to, uint256 amount);
    event OperatorChanged(address indexed operator);
    event FloatWithdrawn(address indexed to, uint256 amount);

    // ----------------------------------------------------------------------------------------------- errors ------

    error InvalidConfig();
    error NotOperator();
    error BadFrameShape(uint256 frameIndex);
    error NotPoolPayerTx();
    error InvalidProcessooor();
    error InvalidFeeData();
    error TailCallsNeedRecipientSender();
    error PoolNotFound();
    error UnsupportedAsset();
    error ContextMismatch();
    error InvalidTreeDepth();
    error NullifierSpent();
    error UnknownStateRoot();
    error StaleASPRoot();
    error InvalidProof();
    error FeeExceedsWithdrawal();
    error FeeBelowQuote(uint256 fee, uint256 quote);
    error AlreadySettled();
    error WithdrawalShort(uint256 received);
    error NotLastFrame();
    error NothingToClaim();
    error TransferFailed();
    error ExceedsFloat(uint256 amount, uint256 float);

    // ------------------------------------------------------------------------------------------ construction ------

    constructor(Config memory c) payable HegotaSupport(c.devnet) {
        if (c.entrypoint == address(0) || c.registry == address(0) || c.operator == address(0)) revert InvalidConfig();
        if (c.feeParam != TxParam.MAX_COST && c.feeParam != TxParam.MAX_FEE) revert InvalidConfig();
        if (
            c.intrinsicGas > MAX_INTRINSIC_GAS || c.perFrameGas > MAX_PER_FRAME_GAS
                || c.gasPerDataByte > MAX_GAS_PER_DATA_BYTE || c.refundFrameGas > MAX_REFUND_FRAME_GAS
        ) revert InvalidConfig();
        ENTRYPOINT = IPrivacyPoolsEntrypoint(c.entrypoint);
        REGISTRY = IERC8421StakingRegistry(c.registry);
        FEE_PARAM = c.feeParam;
        INTRINSIC_GAS = c.intrinsicGas;
        PER_FRAME_GAS = c.perFrameGas;
        GAS_PER_DATA_BYTE = c.gasPerDataByte;
        REFUND_FRAME_GAS = c.refundFrameGas;
        MIN_PAY_STATE_GAS = c.minPayStateGas;
        MIN_SETTLE_GAS = c.minSettleGas;
        MIN_SETTLE_STATE_GAS = c.minSettleStateGas;
        MIN_REFUND_GAS = c.minRefundGas;
        MIN_REFUND_STATE_GAS = c.minRefundStateGas;
        operator = c.operator;
        // A nonzero sentinel, so that the first settle writes nonzero -> nonzero.
        pendingSig = bytes32(uint256(1));
        lastSettled = bytes32(uint256(1));
    }

    /// The pool's push, the operator's float, the registry's stake return.
    receive() external payable {}

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // ------------------------------------------------------------------------------------------- VERIFY ------

    /// The `pay` frame. Static: reads only, then APPROVE(PAYMENT).
    /// @param scope the pool's scope (Entrypoint `scopeToPool`).
    /// @param rootIndexHint the index in the pool's 64-slot root ring that holds `proof.stateRoot` (saves a scan).
    function verify(
        uint256 scope,
        PrivacyPoolsTypes.Withdrawal calldata withdrawal,
        PrivacyPoolsTypes.WithdrawProof calldata proof,
        uint32 rootIndexHint
    ) external {
        // 0. Frame shape (cheap checks first).
        uint256 i = txparam(TxParam.CURRENT_FRAME_INDEX);
        uint256 n = txparam(TxParam.FRAME_COUNT);
        if (
            frameparam(i, FrameParam.MODE) != uint256(FrameMode.VERIFY)
                || frameparam(i, FrameParam.FLAGS) != uint256(Scope.PAYMENT)
                || frameparam(i, FrameParam.STATE_GAS_LIMIT) < MIN_PAY_STATE_GAS
        ) revert BadFrameShape(i);
        // settle(i) right after us, refund() last, and they are different frames.
        if (n < i + 3) revert BadFrameShape(n);
        _requireOwnFrame(i + 1, 36, this.settle.selector, MIN_SETTLE_GAS, MIN_SETTLE_STATE_GAS);
        if (uint256(framedataload(4, i + 1)) != i) revert BadFrameShape(i + 1);
        _requireOwnFrame(n - 1, 4, this.refund.selector, MIN_REFUND_GAS, MIN_REFUND_STATE_GAS);

        // 1. processooor and fee binding (both inside `context`, so the proof binds them).
        if (withdrawal.processooor != address(this)) revert InvalidProcessooor();
        FeeData memory fee = abi.decode(withdrawal.data, (FeeData));
        if (withdrawal.data.length != 128) revert InvalidFeeData();
        if (fee.feeRecipient != address(this) || fee.recipient == address(0) || fee.fee > type(uint96).max) {
            revert InvalidFeeData();
        }
        // Tail calls (frames between settle and refund) must be SENDER frames, and only when the recipient is the
        // sender (the same anti-griefing rule as 0xbow's fee adapter).
        if (n > i + 3) {
            if (fee.recipient != address(uint160(txparam(TxParam.SENDER)))) revert TailCallsNeedRecipientSender();
            for (uint256 f = i + 2; f < n - 1; f++) {
                if (frameparam(f, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert BadFrameShape(f);
            }
        }

        // 2. Pool and context.
        IPrivacyPoolsPool pool = IPrivacyPoolsPool(ENTRYPOINT.scopeToPool(scope));
        if (address(pool) == address(0)) revert PoolNotFound();
        if (pool.ASSET() != NATIVE_ASSET) revert UnsupportedAsset(); // v1: the ETH pool only (§2.6)
        uint256[8] calldata s = proof.pubSignals;
        if (s[7] != uint256(keccak256(abi.encode(withdrawal, scope))) % SNARK_SCALAR_FIELD) revert ContextMismatch();
        if (s[4] > MAX_TREE_DEPTH || s[6] > MAX_TREE_DEPTH) revert InvalidTreeDepth();

        // 3. Pool preconditions, read-only (the same checks `PrivacyPool.withdraw` will make).
        if (pool.nullifierHashes(s[1])) revert NullifierSpent();
        if (s[3] == 0 || rootIndexHint >= ROOT_HISTORY_SIZE || pool.roots(rootIndexHint) != s[3]) {
            revert UnknownStateRoot();
        }
        if (ENTRYPOINT.latestRoot() != s[5]) revert StaleASPRoot();

        // 4. Economics: the fee covers the worst case and the withdrawal covers the fee.
        if (fee.fee > s[2]) revert FeeExceedsWithdrawal();
        uint256 q = quote(txparam(FEE_PARAM));
        if (fee.fee < q) revert FeeBelowQuote(fee.fee, q);

        // 5. The proof.
        if (!IPrivacyPoolsWithdrawalVerifier(pool.WITHDRAWAL_VERIFIER()).verifyProof(proof.pA, proof.pB, proof.pC, s)) {
            revert InvalidProof();
        }

        approve(Scope.PAYMENT);
    }

    /// The fee (in the pool asset) that covers `maxCostWei` of gas. v1: the ETH pool, 1:1 (no oracle, no margin).
    function quote(uint256 maxCostWei) public pure returns (uint256) {
        return maxCostWei;
    }

    // ---------------------------------------------------------------------------------------- execution ------

    /// Frame i+1: withdraw from the pool to this contract, keep the pre-paid fee, push the rest to the recipient.
    /// The arguments come from frame `verifyFrame`'s data, never from this frame's calldata.
    function settle(uint8 verifyFrame) external {
        uint256 i = txparam(TxParam.CURRENT_FRAME_INDEX);
        uint256 v = verifyFrame;
        // Bound to the frame that made PoolPayer the payer of THIS transaction (APPROVE_PAYMENT happens once per tx,
        // so a successful VERIFY frame to PoolPayer's `verify` is that frame).
        if (
            i == 0 || v != i - 1 || address(uint160(frameparam(v, FrameParam.RESOLVED_TARGET))) != address(this)
                || frameparam(v, FrameParam.MODE) != uint256(FrameMode.VERIFY) || frameparam(v, FrameParam.STATUS) != 1
                || bytes4(framedataload(0, v)) != this.verify.selector
        ) revert NotPoolPayerTx();

        bytes32 sigHash = bytes32(txparam(TxParam.SIG_HASH));
        if (lastSettled == sigHash) revert AlreadySettled();
        lastSettled = sigHash;

        bytes memory args = framedatacopy(4, frameparam(v, FrameParam.DATA_LENGTH) - 4, v);
        (uint256 scope, PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p,) =
            abi.decode(args, (uint256, PrivacyPoolsTypes.Withdrawal, PrivacyPoolsTypes.WithdrawProof, uint32));
        FeeData memory fee = abi.decode(w.data, (FeeData));

        IPrivacyPoolsPool pool = IPrivacyPoolsPool(ENTRYPOINT.scopeToPool(scope));
        uint256 before = address(this).balance;
        pool.withdraw(w, p); // pool: processooor == msg.sender, context, roots, ASP root, proof; pushes value to us
        uint256 received = address(this).balance - before;
        if (received < fee.fee) revert WithdrawalShort(received);

        pendingSig = sigHash;
        pendingFee = uint96(fee.fee);
        pendingRefundTo = fee.refundRecipient == address(0) ? fee.recipient : fee.refundRecipient;

        uint256 paid = received - fee.fee;
        _payoutOrCredit(fee.recipient, paid);
        emit Settled(sigHash, p.pubSignals[1], fee.recipient, paid, fee.fee);
    }

    /// The last frame: refund `fee - costEstimate()` to the refund recipient. A no-op when `settle` did not run in
    /// this transaction (it reverted: PoolPayer absorbs that gas, §2.2) or outside a PoolPayer transaction.
    function refund() external {
        uint256 i = txparam(TxParam.CURRENT_FRAME_INDEX);
        if (i + 1 != txparam(TxParam.FRAME_COUNT)) revert NotLastFrame();
        bytes32 sigHash = bytes32(txparam(TxParam.SIG_HASH));
        if (pendingSig != sigHash) return;
        pendingSig = ~sigHash;

        uint256 cost = costEstimate(i) * tx.gasprice;
        uint256 fee = pendingFee;
        uint256 amount = fee > cost ? fee - cost : 0;
        address to = pendingRefundTo;
        _payoutOrCredit(to, amount);
        emit Refunded(sigHash, to, amount, cost);
    }

    /// Gas the protocol charges this transaction, as a lower bound, when called from frame `self` (the last one):
    ///   INTRINSIC_GAS + n·PER_FRAME_GAS + Σ_f DATA_LENGTH(f)·GAS_PER_DATA_BYTE        (intrinsic, lower bound)
    /// + Σ_{f < self} (EXECUTION_GAS_USED(f) + STATE_GAS_USED(f))                     (exact, from the receipts)
    /// + REFUND_FRAME_GAS                                                              (this frame, lower bound)
    /// Priced at GASPRICE, which EIP-8141 defines as a lower bound of the per-gas price paid (§Fee budget, L1495).
    /// It is a lower bound as long as nothing earns an SSTORE refund larger than the intrinsic slack: PoolPayer never
    /// zeroes or restores a slot, and neither does `PrivacyPool.withdraw`.
    function costEstimate(uint256 self) public view returns (uint256 gas) {
        uint256 n = txparam(TxParam.FRAME_COUNT);
        uint256 dataBytes;
        for (uint256 f; f < n; f++) {
            dataBytes += frameparam(f, FrameParam.DATA_LENGTH);
            if (f < self) {
                gas += frameparam(f, FrameParam.EXECUTION_GAS_USED) + frameparam(f, FrameParam.STATE_GAS_USED);
            }
        }
        gas += INTRINSIC_GAS + n * PER_FRAME_GAS + dataBytes * GAS_PER_DATA_BYTE + REFUND_FRAME_GAS;
    }

    /// Pull fallback for a recipient whose push failed. Callable from any context; pays `msg.sender`'s credit to `to`.
    function claim(address payable to) external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, to, amount);
    }

    // -------------------------------------------------------------------------------- operator / staking ------

    /// ERC-8421 stake. The registry keys stake on msg.sender, so PoolPayer has to call it itself.
    function stake(uint32 unstakeDelaySec) external payable onlyOperator {
        REGISTRY.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOperator {
        REGISTRY.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOperator {
        REGISTRY.withdrawStake(to);
    }

    /// The operator's own gas float only: never the users' credits.
    function withdrawFloat(address payable to, uint256 amount) external onlyOperator {
        uint256 float = address(this).balance - totalClaimable;
        if (amount > float) revert ExceedsFloat(amount, float);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FloatWithdrawn(to, amount);
    }

    function setOperator(address newOperator) external onlyOperator {
        if (newOperator == address(0)) revert InvalidConfig();
        operator = newOperator;
        emit OperatorChanged(newOperator);
    }

    // ------------------------------------------------------------------------------------------ internals ------

    /// Frame `f` is a DEFAULT, non-batched, value-less call to this contract with `len` bytes of data starting with
    /// `selector`, and enough execution and state gas.
    function _requireOwnFrame(uint256 f, uint256 len, bytes4 selector, uint256 minGas, uint256 minStateGas)
        internal
        view
    {
        if (
            address(uint160(frameparam(f, FrameParam.RESOLVED_TARGET))) != address(this)
                || frameparam(f, FrameParam.MODE) != uint256(FrameMode.DEFAULT) || frameparam(f, FrameParam.FLAGS) != 0
                || frameparam(f, FrameParam.DATA_LENGTH) != len || bytes4(framedataload(0, f)) != selector
                || frameparam(f, FrameParam.EXECUTION_GAS_LIMIT) < minGas
                || frameparam(f, FrameParam.STATE_GAS_LIMIT) < minStateGas
        ) revert BadFrameShape(f);
    }

    /// Never reverts: a bounded-gas push, else a credit the recipient pulls with `claim` (rule 1).
    function _payoutOrCredit(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (!ok) {
            claimable[to] += amount;
            totalClaimable += amount;
            emit Credited(to, amount);
        }
    }
}

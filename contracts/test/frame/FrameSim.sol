// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Opcode} from "@forshtat/hegota-support/contracts/Opcode.sol";
import {HelperCode} from "@forshtat/hegota-support/contracts/generated/HelperCode.sol";
import {FrameTxModel} from "./FrameTxModel.sol";
import {
    MockApprove,
    MockTxParam,
    MockFrameDataLoad,
    MockFrameDataCopy,
    MockFrameParam,
    MockSigParam,
    MockSigDataCopy,
    MockUnmodelled
} from "./FrameMocks.sol";

/// @title FrameSim
/// @notice Base for Foundry tests of contracts that use EIP-8141 frame opcodes through `HegotaSupport`. It replaces
///         the contract's opcode helpers with mocks backed by a `FrameTxModel` (one simulated frame transaction) and
///         runs the transaction's frames the way the protocol does: VERIFY and DEFAULT frames are called by
///         ENTRY_POINT, SENDER frames by `tx.sender` and only after the sender was approved, a VERIFY frame that does
///         not succeed makes the transaction invalid, a transaction without a payer is invalid, and failed atomic
///         batches are rolled back.
///
///         Usage:
///             MyAccount a = new MyAccount(...);
///             simAttach(address(a));                     // after construction: mocks over its 7 helpers
///             simBegin(address(a));                      // new tx, sender = a, nonce = a's current nonce
///             simVerify(ONLY_VERIFY, address(0), 80_000, abi.encodeCall(MyAccount.verifyFrame, ()));
///             simVerify(PAY, tank, 30_000, "");          // default-code EOA payer
///             simSender(address(0), 200_000, 0, abi.encodeCall(MyAccount.hotExecute, (...)));
///             simAddSecp256k1(hot);  simAddSecp256k1(tank);
///             simSignSecp256k1(0, hotKey); simSignSecp256k1(1, tankKey);
///             SimResult memory r = simRun();
///
/// @dev What this does NOT model (it is a unit-test harness; the devnet is authoritative, §10.1.5):
///      - the RLP sig hash: `simSetSigHash` sets an opaque value (default: a hash of the frames and signature
///        metadata, see `_defaultSigHash`); use the TypeScript codec (packages/frames) for real sig hashes;
///      - gas: the mocks cost far more than the opcodes (a model call per read, storage writes per APPROVE), so frames
///        run with all available gas by default and `gasUsed` is only indicative. `simEnforceGasLimits(true)` passes
///        `limits.execution` as the call's gas instead. Intrinsic gas, state gas and fee settlement are not
///        modelled: PAYMENT approvals debit `maxCost` from the payer and bump the sender's nonce, nothing else;
///      - STATICCALL for VERIFY frames is emulated: the frame runs as a normal call under state-diff and log
///        recording, and any storage write, log, value transfer, CREATE or SELFDESTRUCT outside the model makes it a
///        static violation. TSTORE is not seen (Foundry does not record transient storage): on chain it reverts in
///        VERIFY and is discarded between frames, here it persists for the whole `simRun`;
///      - P256 signatures, EIP-8250 keyed-nonce TXPARAMs, EIP-7906 opcodes (they revert `FrameSimUnsupported`);
///      - mempool rules beyond what the state diff shows (`FrameOutcome.foreignSloads`, `bannedAccesses` for
///        BALANCE and calls to code-less addresses): SELFBALANCE, TIMESTAMP, NUMBER, GAS, GASPRICE, BASEFEE and the
///        other banned opcodes pass here and fail on the devnet (§10.1.4 item 2, §10.1.5);
///      - exceptional halts of the opcodes revert with `FrameSimHalt` data instead of burning the helper call's gas,
///        so a `try`/`catch` around a helper read behaves differently here than on chain.
///      Helper addresses: HegotaSupport CREATEs one helper per opcode the devnet has, in `Opcode` order, from the
///      constructor, so they sit at `computeCreateAddress(account, 1..n)`. With a proxy, attach to the
///      implementation (the helpers are the implementation's immutables).
abstract contract FrameSim is Test {
    // --------------------------------------------------------------------------------------------- constants ------

    address internal constant ENTRY_POINT = address(0xaa);

    uint8 internal constant MODE_DEFAULT = 0;
    uint8 internal constant MODE_VERIFY = 1;
    uint8 internal constant MODE_SENDER = 2;

    /// Frame flags: the approval scope (bits 0-1) and the atomic-batch bit. Named after EIP-8141's subclasses.
    uint8 internal constant SCOPE_NONE = 0x0;
    uint8 internal constant PAY = 0x1;
    uint8 internal constant ONLY_VERIFY = 0x2;
    uint8 internal constant SELF_VERIFY = 0x3;
    uint8 internal constant ATOMIC_BATCH = 0x4;

    uint8 internal constant SCHEME_ARBITRARY = 0x0;
    uint8 internal constant SCHEME_SECP256K1 = 0x1;
    uint8 internal constant SCHEME_P256 = 0x2;

    uint8 internal constant STATUS_FAILED = 0;
    uint8 internal constant STATUS_SUCCESS = 1;
    uint8 internal constant STATUS_SKIPPED = 2;
    /// Not executed because the transaction became invalid earlier.
    uint8 internal constant STATUS_NOT_RUN = 255;

    uint256 internal constant MAX_FRAMES = 64;
    uint256 private constant SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    // ------------------------------------------------------------------------------------------------ types ------

    enum InvalidReason {
        NONE,
        STATIC_CONSTRAINT,
        NONCE_MISMATCH,
        BAD_SIGNATURE,
        SENDER_NOT_APPROVED,
        VERIFY_FAILED,
        VERIFY_NOT_STATIC,
        NO_PAYER
    }

    struct FrameOutcome {
        uint8 status;
        uint256 gasUsed;
        bytes returnData;
        /// VERIFY frames: a storage write, log, value transfer, CREATE or SELFDESTRUCT outside the model.
        bool staticViolation;
        /// VERIFY frames: SLOADs of accounts other than tx.sender (the canonical mempool rejects these).
        uint256 foreignSloads;
        address firstForeignAccount;
        bytes32 firstForeignSlot;
        /// VERIFY frames: accesses the public mempool rejects that Foundry can see: BALANCE (not SELFBALANCE), and
        /// CALL* / EXTCODE* to an address that is neither a contract nor a precompile (other than tx.sender). Other
        /// banned opcodes (TIMESTAMP, NUMBER, GAS, ...) are not detected here: the devnet trace is authoritative.
        uint256 bannedAccesses;
        string firstBannedAccess;
    }

    struct SimResult {
        bool valid;
        InvalidReason reason;
        /// The frame or signature index the reason refers to.
        uint256 index;
        address payer;
        /// The frame that set the payer (end of the validation prefix); type(uint256).max when none did.
        uint256 prefixEnd;
        FrameOutcome[] frames;
    }

    // ------------------------------------------------------------------------------------------------ state ------

    FrameTxModel private _model;
    bool private _sigHashSet;
    bool private _enforceGas;

    // ------------------------------------------------------------------------------------------------ setup ------

    /// The model behind the mocks, created on first use.
    function sim() internal returns (FrameTxModel) {
        if (address(_model) == address(0)) {
            _model = new FrameTxModel();
            vm.label(address(_model), "FrameTxModel");
            vm.label(ENTRY_POINT, "ENTRY_POINT");
        }
        return _model;
    }

    /// Etches mock helpers over `account`'s HegotaSupport helpers (devnet ERC8421_WORKSHOP, chain 1337).
    function simAttach(address account) internal {
        simAttach(account, Devnet.ERC8421_WORKSHOP);
    }

    function simAttach(address account, Devnet devnet) internal {
        FrameTxModel m = sim();
        uint256 n;
        for (uint256 op; op <= uint256(type(Opcode).max); op++) {
            if (_helperCode(devnet, Opcode(op)).length == 0) continue;
            n++;
            vm.etch(vm.computeCreateAddress(account, n), _mockCode(Opcode(op), m));
        }
    }

    /// The address of `account`'s helper for `opcode`, or address(0) when the devnet has no such opcode.
    function simHelperAddress(address account, Devnet devnet, Opcode opcode) internal pure returns (address) {
        uint256 n;
        for (uint256 op; op <= uint256(opcode); op++) {
            if (_helperCode(devnet, Opcode(op)).length == 0) {
                if (op == uint256(opcode)) return address(0);
                continue;
            }
            n++;
        }
        return vm.computeCreateAddress(account, n);
    }

    // ------------------------------------------------------------------------------------- building a tx ------

    /// Starts a new transaction from `sender`, with the sender's current nonce and zero fees.
    function simBegin(address sender) internal {
        FrameTxModel m = sim();
        m.reset();
        m.setTx(sender, vm.getNonce(sender), 0, 0, 0);
        _sigHashSet = false;
    }

    /// Fees: `maxCost` is what a PAYMENT approval requires and collects (TXPARAM 0x06 on the devnet).
    function simSetFees(uint256 maxPriorityFeePerGas, uint256 maxFee, uint256 maxCost) internal {
        FrameTxModel m = sim();
        m.setTx(m.sender(), m.nonce(), maxPriorityFeePerGas, maxFee, maxCost);
    }

    function simSetNonce(uint256 nonce) internal {
        FrameTxModel m = sim();
        m.setTx(m.sender(), nonce, m.maxPriorityFeePerGas(), m.maxFee(), m.maxCost());
    }

    /// Whether frames get exactly `limits.execution` gas (off by default: the mocks are expensive, see above).
    function simEnforceGasLimits(bool on) internal {
        _enforceGas = on;
    }

    /// Fixes TXPARAM_SIG_HASH. Without it, `simSign*` and `simRun` use `_defaultSigHash()`.
    function simSetSigHash(bytes32 h) internal {
        sim().setSigHash(h);
        _sigHashSet = true;
    }

    function simAddFrame(
        uint8 mode,
        uint8 flags,
        address target,
        uint64 execution,
        uint64 state,
        uint256 value,
        bytes memory data
    ) internal returns (uint256) {
        return sim().pushFrame(FrameTxModel.Frame(mode, flags, target, execution, state, value, data));
    }

    function simVerify(uint8 flags, address target, uint64 execution, bytes memory data) internal returns (uint256) {
        return simAddFrame(MODE_VERIFY, flags, target, execution, 0, 0, data);
    }

    function simSender(address target, uint64 execution, uint256 value, bytes memory data) internal returns (uint256) {
        return simAddFrame(MODE_SENDER, 0, target, execution, 0, value, data);
    }

    function simDefault(address target, uint64 execution, bytes memory data) internal returns (uint256) {
        return simAddFrame(MODE_DEFAULT, 0, target, execution, 0, 0, data);
    }

    /// A SECP256K1 entry over the sig hash; `signer == address(0)` means tx.sender.
    function simAddSecp256k1(address signer) internal returns (uint256) {
        return sim().pushSig(FrameTxModel.Sig(SCHEME_SECP256K1, signer, bytes32(0), ""));
    }

    /// An ARBITRARY entry (witness bytes that the contract checks itself, read with SIGDATACOPY).
    function simAddArbitrary(bytes memory witness) internal returns (uint256) {
        return sim().pushSig(FrameTxModel.Sig(SCHEME_ARBITRARY, address(0), bytes32(0), witness));
    }

    function simAddSig(uint8 scheme, address signer, bytes32 msgHash, bytes memory signature)
        internal
        returns (uint256)
    {
        return sim().pushSig(FrameTxModel.Sig(scheme, signer, msgHash, signature));
    }

    function simSetSignature(uint256 index, bytes memory signature) internal {
        sim().setSignature(index, signature);
    }

    /// Signs entry `index` (its `msg`, or the sig hash when `msg` is empty) as `v (0/1) || r || s`, low-s.
    function simSignSecp256k1(uint256 index, uint256 privateKey) internal {
        FrameTxModel m = sim();
        _ensureSigHash();
        FrameTxModel.Sig memory s = m.sigAt(index);
        bytes32 digest = s.msgHash == bytes32(0) ? m.sigHash() : s.msgHash;
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(privateKey, digest);
        if (uint256(sv) > SECP256K1N / 2) {
            sv = bytes32(SECP256K1N - uint256(sv));
            v = v == 27 ? 28 : 27;
        }
        m.setSignature(index, abi.encodePacked(v - 27, r, sv));
    }

    // ------------------------------------------------------------------------------------------- running ------

    /// Runs the whole transaction. An invalid transaction leaves no state behind (the run is rolled back), as on
    /// chain; the result still reports the frames up to the point of failure.
    function simRun() internal returns (SimResult memory r) {
        _ensureSigHash();
        uint256 snap = vm.snapshotState();
        r = _run();
        if (!r.valid) vm.revertToState(snap);
    }

    /// Like `simRun`, but fails the test unless the transaction is valid.
    function simRunValid() internal returns (SimResult memory r) {
        r = simRun();
        if (!r.valid) {
            emit log_named_uint("FrameSim: invalid transaction, reason", uint256(r.reason));
            emit log_named_uint("FrameSim: at index", r.index);
            fail();
        }
    }

    /// Runs frame `i` alone, without the transaction-level checks; for unit tests of one VERIFY function.
    /// Earlier frames count as not run, so the approval context is whatever earlier `simRunFrame` calls left.
    function simRunFrame(uint256 i) internal returns (FrameOutcome memory) {
        _ensureSigHash();
        return _execFrame(i);
    }

    /// Puts the model inside frame `i` so that a test can call a contract directly (e.g. with `vm.prank`) and have
    /// its opcode reads answered. Pair with `simLeave`.
    function simEnter(uint256 i) internal {
        _ensureSigHash();
        sim().enter(i);
    }

    function simLeave(uint256 i, uint8 status) internal {
        sim().leave(i, status, 0);
    }

    function simApprovals() internal returns (FrameTxModel.Approval[] memory) {
        return sim().approvals();
    }

    // ------------------------------------------------------------------------------------------ internals ------

    function _run() private returns (SimResult memory r) {
        FrameTxModel m = sim();
        uint256 n = m.frameCount();
        r.frames = new FrameOutcome[](n);
        r.prefixEnd = type(uint256).max;
        for (uint256 i; i < n; i++) {
            r.frames[i].status = STATUS_NOT_RUN;
        }

        (bool ok, uint256 at) = _staticChecks();
        if (!ok) return _invalid(r, InvalidReason.STATIC_CONSTRAINT, at);
        if (m.nonce() != vm.getNonce(m.sender())) return _invalid(r, InvalidReason.NONCE_MISMATCH, 0);
        (ok, at) = _signaturesValid();
        if (!ok) return _invalid(r, InvalidReason.BAD_SIGNATURE, at);

        uint256 batchSnap;
        uint256 batchStart;
        for (uint256 i; i < n; i++) {
            FrameTxModel.Frame memory f = m.frameAt(i);
            bool continuesBatch = i > 0 && m.frameAt(i - 1).flags & ATOMIC_BATCH != 0;
            bool inBatch = continuesBatch || f.flags & ATOMIC_BATCH != 0;
            if (f.flags & ATOMIC_BATCH != 0 && !continuesBatch) {
                batchSnap = vm.snapshotState();
                batchStart = i;
            }
            if (f.mode == MODE_SENDER && !m.senderApproved()) {
                return _invalid(r, InvalidReason.SENDER_NOT_APPROVED, i);
            }

            address payerBefore = m.payer();
            FrameOutcome memory o = _execFrame(i);
            r.frames[i] = o;

            if (f.mode == MODE_VERIFY) {
                if (o.staticViolation) return _invalid(r, InvalidReason.VERIFY_NOT_STATIC, i);
                if (o.status != STATUS_SUCCESS) return _invalid(r, InvalidReason.VERIFY_FAILED, i);
            }
            if (payerBefore == address(0) && m.payer() != address(0)) {
                r.prefixEnd = i;
                _collect(m);
            }
            if (inBatch && o.status == STATUS_FAILED) {
                // Roll the batch back to its start; executed frames keep status and gas, the rest are skipped.
                vm.revertToState(batchSnap);
                for (uint256 k = batchStart; k <= i; k++) {
                    m.leave(k, r.frames[k].status, r.frames[k].gasUsed);
                }
                uint256 j = i;
                while (j + 1 < n && m.frameAt(j).flags & ATOMIC_BATCH != 0) {
                    j++;
                    r.frames[j].status = STATUS_SKIPPED;
                    m.leave(j, STATUS_SKIPPED, 0);
                }
                i = j;
            }
        }
        if (m.payer() == address(0)) return _invalid(r, InvalidReason.NO_PAYER, n);
        r.valid = true;
        r.payer = m.payer();
    }

    function _invalid(SimResult memory r, InvalidReason reason, uint256 index)
        private
        pure
        returns (SimResult memory)
    {
        r.valid = false;
        r.reason = reason;
        r.index = index;
        return r;
    }

    /// A PAYMENT approval increments the sender's nonce and collects max_cost from the payer.
    function _collect(FrameTxModel m) private {
        address sender = m.sender();
        vm.setNonce(sender, uint64(vm.getNonce(sender) + 1));
        address payer = m.payer();
        vm.deal(payer, payer.balance - m.maxCost());
    }

    function _execFrame(uint256 i) private returns (FrameOutcome memory o) {
        FrameTxModel m = sim();
        FrameTxModel.Frame memory f = m.frameAt(i);
        address target = m.resolvedTarget(i);
        address caller = f.mode == MODE_SENDER ? m.sender() : ENTRY_POINT;
        bool verify = f.mode == MODE_VERIFY;

        m.enter(i);
        uint256 snap;
        if (verify) {
            snap = vm.snapshotState();
            vm.recordLogs();
            vm.startStateDiffRecording();
        }

        bool ok;
        if (target.code.length == 0) {
            if (verify) {
                ok = _defaultCodeVerify(m, f, target);
            } else if (f.value > 0) {
                vm.prank(caller, caller);
                (ok, o.returnData) = target.call{value: f.value}("");
            } else {
                ok = true;
            }
        } else {
            vm.prank(caller, caller);
            uint256 g0 = gasleft();
            uint256 gasForFrame = _enforceGas ? f.execution : gasleft();
            (ok, o.returnData) = target.call{gas: gasForFrame, value: f.value}(f.data);
            o.gasUsed = g0 - gasleft();
        }

        if (verify) {
            Vm.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
            _inspectVerify(o, acc, address(m), m.sender());
            // LOG is not allowed in a STATICCALL (a reverted frame's logs are already discarded).
            if (ok && vm.getRecordedLogs().length > 0) o.staticViolation = true;
            if (o.staticViolation) {
                vm.revertToState(snap);
                ok = false;
            }
        }
        o.status = ok ? STATUS_SUCCESS : STATUS_FAILED;
        m.leave(i, o.status, o.gasUsed);
    }

    /// The EIP-8141 default code for a VERIFY frame whose target has no code.
    function _defaultCodeVerify(FrameTxModel m, FrameTxModel.Frame memory f, address target) private returns (bool) {
        uint256 scope = f.flags & SELF_VERIFY;
        if (scope == 0) return false;
        uint256 sigIndex = scope & ONLY_VERIFY != 0 ? 0 : 1;
        if (sigIndex >= m.sigCount()) return false;
        FrameTxModel.Sig memory s = m.sigAt(sigIndex);
        address signer = s.signer == address(0) ? m.sender() : s.signer;
        if (s.scheme != SCHEME_SECP256K1 || signer != target || s.msgHash != bytes32(0)) return false;
        try m.defaultCodeApprove(scope) {
            return true;
        } catch {
            return false;
        }
    }

    function _inspectVerify(FrameOutcome memory o, Vm.AccountAccess[] memory acc, address model, address sender)
        private
        view
    {
        for (uint256 a; a < acc.length; a++) {
            Vm.AccountAccess memory x = acc[a];
            if (!x.reverted) {
                if (x.kind == VmSafe.AccountAccessKind.Create || x.kind == VmSafe.AccountAccessKind.SelfDestruct) {
                    o.staticViolation = true;
                }
                if (x.kind == VmSafe.AccountAccessKind.Call && x.value > 0) o.staticViolation = true;
                // The model's own balance check (APPROVE's rule) and calls into the model are the protocol, not
                // the contract under test.
                if (x.accessor != model && x.account != model) {
                    if (x.kind == VmSafe.AccountAccessKind.Balance) {
                        _banned(o, "BALANCE in the validation prefix");
                    } else if (
                        _isCallOrExtcode(x.kind) && x.account != sender && x.account.code.length == 0
                            && uint160(x.account) > 0x100
                    ) {
                        _banned(o, "CALL*/EXTCODE* to an address without code");
                    }
                }
            }
            for (uint256 s; s < x.storageAccesses.length; s++) {
                Vm.StorageAccess memory st = x.storageAccesses[s];
                if (st.account == model) continue;
                if (st.isWrite) {
                    if (!st.reverted) o.staticViolation = true;
                } else if (st.account != sender) {
                    if (o.foreignSloads == 0) {
                        o.firstForeignAccount = st.account;
                        o.firstForeignSlot = st.slot;
                    }
                    o.foreignSloads++;
                }
            }
        }
    }

    function _banned(FrameOutcome memory o, string memory what) private pure {
        if (o.bannedAccesses == 0) o.firstBannedAccess = what;
        o.bannedAccesses++;
    }

    function _isCallOrExtcode(VmSafe.AccountAccessKind k) private pure returns (bool) {
        return k == VmSafe.AccountAccessKind.Call || k == VmSafe.AccountAccessKind.StaticCall
            || k == VmSafe.AccountAccessKind.DelegateCall || k == VmSafe.AccountAccessKind.CallCode
            || k == VmSafe.AccountAccessKind.Extcodesize || k == VmSafe.AccountAccessKind.Extcodehash
            || k == VmSafe.AccountAccessKind.Extcodecopy;
    }

    /// The static constraints of EIP-8141 §"Constraints" that the model can express.
    function _staticChecks() private returns (bool, uint256) {
        FrameTxModel m = sim();
        uint256 n = m.frameCount();
        if (n == 0 || n > MAX_FRAMES) return (false, n);
        address sender = m.sender();
        for (uint256 i; i < n; i++) {
            FrameTxModel.Frame memory f = m.frameAt(i);
            if (f.mode > MODE_SENDER || f.flags >= 8) return (false, i);
            if (f.mode != MODE_SENDER && f.value != 0) return (false, i);
            if (f.flags & ONLY_VERIFY != 0 && f.target != address(0) && f.target != sender) return (false, i);
            if (f.flags & ATOMIC_BATCH != 0) {
                if (f.mode == MODE_VERIFY || i + 1 >= n || m.frameAt(i + 1).mode == MODE_VERIFY) return (false, i);
            }
            bool member = f.flags & ATOMIC_BATCH != 0 || (i > 0 && m.frameAt(i - 1).flags & ATOMIC_BATCH != 0);
            if (member && f.flags & SELF_VERIFY != 0) return (false, i);
        }
        uint256 k = m.sigCount();
        for (uint256 i; i < k; i++) {
            FrameTxModel.Sig memory s = m.sigAt(i);
            if (s.scheme > SCHEME_P256) return (false, i);
            if (s.scheme == SCHEME_ARBITRARY && s.signer != address(0)) return (false, i);
        }
        return (true, 0);
    }

    /// EIP-8141 `validate_signature` for every entry. P256 is not modelled.
    function _signaturesValid() private returns (bool, uint256) {
        FrameTxModel m = sim();
        uint256 k = m.sigCount();
        for (uint256 i; i < k; i++) {
            FrameTxModel.Sig memory s = m.sigAt(i);
            if (s.scheme == SCHEME_ARBITRARY) continue;
            if (s.scheme == SCHEME_P256) revert FrameTxModel.FrameSimUnsupported("P256 signature", i);
            bytes memory sig = s.signature;
            if (sig.length != 65) return (false, i);
            uint8 v = uint8(sig[0]);
            bytes32 r;
            bytes32 sv;
            assembly ("memory-safe") {
                r := mload(add(sig, 33))
                sv := mload(add(sig, 65))
            }
            if (v > 1 || uint256(r) == 0 || uint256(r) >= SECP256K1N) return (false, i);
            if (uint256(sv) == 0 || uint256(sv) > SECP256K1N / 2) return (false, i);
            bytes32 digest = s.msgHash == bytes32(0) ? m.sigHash() : s.msgHash;
            address signer = s.signer == address(0) ? m.sender() : s.signer;
            if (ecrecover(digest, v + 27, r, sv) != signer) return (false, i);
        }
        return (true, 0);
    }

    function _ensureSigHash() private {
        if (!_sigHashSet) sim().setSigHash(_defaultSigHash());
    }

    /// A stand-in for compute_sig_hash: it commits to everything but the signature bytes of empty-msg entries.
    function _defaultSigHash() private returns (bytes32) {
        FrameTxModel m = sim();
        bytes memory acc = abi.encode(m.sender(), m.nonce(), m.maxPriorityFeePerGas(), m.maxFee());
        uint256 n = m.frameCount();
        for (uint256 i; i < n; i++) {
            acc = abi.encode(acc, m.frameAt(i));
        }
        uint256 k = m.sigCount();
        for (uint256 i; i < k; i++) {
            FrameTxModel.Sig memory s = m.sigAt(i);
            acc = abi.encode(acc, s.scheme, s.signer, s.msgHash, s.msgHash == bytes32(0) ? bytes("") : s.signature);
        }
        return keccak256(acc);
    }

    function _helperCode(Devnet devnet, Opcode op) private pure returns (bytes memory) {
        if (op == Opcode.Approve) return HelperCode.approve(devnet);
        if (op == Opcode.TxParam) return HelperCode.txParam(devnet);
        if (op == Opcode.FrameDataLoad) return HelperCode.frameDataLoad(devnet);
        if (op == Opcode.FrameDataCopy) return HelperCode.frameDataCopy(devnet);
        if (op == Opcode.FrameParam) return HelperCode.frameParam(devnet);
        if (op == Opcode.SigParam) return HelperCode.sigParam(devnet);
        if (op == Opcode.SigDataCopy) return HelperCode.sigDataCopy(devnet);
        if (op == Opcode.TxTrace) return HelperCode.txTrace(devnet);
        return HelperCode.eventDataCopy(devnet);
    }

    function _mockCode(Opcode op, FrameTxModel m) private returns (bytes memory) {
        if (op == Opcode.Approve) return address(new MockApprove(m)).code;
        if (op == Opcode.TxParam) return address(new MockTxParam(m)).code;
        if (op == Opcode.FrameDataLoad) return address(new MockFrameDataLoad(m)).code;
        if (op == Opcode.FrameDataCopy) return address(new MockFrameDataCopy(m)).code;
        if (op == Opcode.FrameParam) return address(new MockFrameParam(m)).code;
        if (op == Opcode.SigParam) return address(new MockSigParam(m)).code;
        if (op == Opcode.SigDataCopy) return address(new MockSigDataCopy(m)).code;
        return address(new MockUnmodelled()).code;
    }
}

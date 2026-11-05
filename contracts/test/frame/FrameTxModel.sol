// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FrameTxModel
/// @notice The state of one simulated EIP-8141 frame transaction, for Foundry tests. The mock opcode helpers that
///         `FrameSim` etches over a `HegotaSupport` contract's helpers answer TXPARAM / FRAMEPARAM / FRAMEDATALOAD /
///         FRAMEDATACOPY / SIGPARAM / SIGDATACOPY from this model, and the mock APPROVE updates its approval context.
/// @dev Semantics follow the EIP-8141 text (`docs/plan/sections/10-contracts.md` §10.1.4; EIP sections "APPROVE
///      Instruction" and "Introspection"). Where the EIP says "exceptional halt", the model reverts with
///      `FrameSimHalt`; a real halt also consumes all of the frame's gas, which the model does not reproduce.
///      Only the owner (the `FrameSim` test) can change the transaction; `approve` is called by the account under
///      test (through the delegatecalled mock), and `msg.sender` stands for the EVM's ADDRESS.
contract FrameTxModel {
    // ------------------------------------------------------------------------------------------- constants ------

    uint8 internal constant MODE_DEFAULT = 0;
    uint8 internal constant MODE_VERIFY = 1;
    uint8 internal constant MODE_SENDER = 2;

    uint256 internal constant SCOPE_PAYMENT = 0x1;
    uint256 internal constant SCOPE_EXECUTION = 0x2;
    uint256 internal constant SCOPE_MASK = 0x3;

    uint8 internal constant SCHEME_ARBITRARY = 0x0;

    /// Frame status values (FRAMEPARAM_STATUS): 0 failure, 1 success, 2 skipped by a failed atomic batch.
    uint8 internal constant STATUS_FAILED = 0;
    uint8 internal constant STATUS_SUCCESS = 1;
    uint8 internal constant STATUS_SKIPPED = 2;

    // ------------------------------------------------------------------------------------------------ types ------

    struct Frame {
        uint8 mode;
        uint8 flags;
        /// address(0) encodes an empty target (= tx.sender).
        address target;
        uint64 execution;
        uint64 state;
        uint256 value;
        bytes data;
    }

    struct Sig {
        uint8 scheme;
        /// address(0) encodes an empty signer (= tx.sender for SECP256K1 / P256; required for ARBITRARY).
        address signer;
        /// bytes32(0) encodes an empty msg (= the canonical signature hash).
        bytes32 msgHash;
        bytes signature;
    }

    struct Approval {
        uint256 frameIndex;
        address target;
        uint256 scope;
    }

    // ------------------------------------------------------------------------------------------------ state ------

    address public immutable owner;

    address public sender;
    uint256 public nonce;
    uint256 public maxPriorityFeePerGas;
    uint256 public maxFee;
    /// TXPARAM 0x06 on the ethrex devnet (not in the EIP text); also what a PAYMENT approval collects here.
    uint256 public maxCost;
    uint256 public blobCount;
    bytes32 public sigHash;

    Frame[] internal _frames;
    Sig[] internal _sigs;

    bool public inFrame;
    uint256 public currentFrame;
    bool public senderApproved;
    address public payer;

    mapping(uint256 => uint8) internal _status;
    mapping(uint256 => uint256) internal _gasUsed;
    Approval[] internal _approvals;

    // ----------------------------------------------------------------------------------------------- errors ------

    /// What a real EVM does with an exceptional halt; `what` names the rule.
    error FrameSimHalt(string what);
    /// The simulator does not model this parameter (its semantics are not in the EIP-8141 text).
    error FrameSimUnsupported(string what, uint256 id);
    /// APPROVE reverted the frame; `why` names the EIP-8141 rule.
    error ApproveReverted(string why);
    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------------------------------------- owner: setup ------

    function reset() external onlyOwner {
        delete _frames;
        delete _sigs;
        delete _approvals;
        sender = address(0);
        nonce = 0;
        maxPriorityFeePerGas = 0;
        maxFee = 0;
        maxCost = 0;
        blobCount = 0;
        sigHash = bytes32(0);
        inFrame = false;
        currentFrame = 0;
        senderApproved = false;
        payer = address(0);
    }

    function setTx(address sender_, uint256 nonce_, uint256 maxPriorityFeePerGas_, uint256 maxFee_, uint256 maxCost_)
        external
        onlyOwner
    {
        sender = sender_;
        nonce = nonce_;
        maxPriorityFeePerGas = maxPriorityFeePerGas_;
        maxFee = maxFee_;
        maxCost = maxCost_;
    }

    function setSigHash(bytes32 h) external onlyOwner {
        sigHash = h;
    }

    function setBlobCount(uint256 n) external onlyOwner {
        blobCount = n;
    }

    function pushFrame(Frame calldata f) external onlyOwner returns (uint256 index) {
        index = _frames.length;
        _frames.push(f);
    }

    function pushSig(Sig calldata s) external onlyOwner returns (uint256 index) {
        index = _sigs.length;
        _sigs.push(s);
    }

    function setSignature(uint256 i, bytes calldata signature) external onlyOwner {
        _sigs[i].signature = signature;
    }

    // ------------------------------------------------------------------------------------ owner: execution ------

    function enter(uint256 i) external onlyOwner {
        currentFrame = i;
        inFrame = true;
    }

    function leave(uint256 i, uint8 status, uint256 gasUsed) external onlyOwner {
        _status[i] = status;
        _gasUsed[i] = gasUsed;
        inFrame = false;
    }

    /// The EIP's default code for a VERIFY frame whose target has no code: APPROVE on behalf of that target.
    function defaultCodeApprove(uint256 scope) external onlyOwner {
        _approve(_resolvedTarget(currentFrame), scope);
    }

    // ------------------------------------------------------------------------------------------- APPROVE ------

    /// APPROVE (0xaa), called by the delegatecalled mock helper: `msg.sender` is the executing account (ADDRESS).
    function approve(uint256 scope) external {
        if (!inFrame) revert FrameSimHalt("APPROVE outside a frame transaction");
        _approve(msg.sender, scope);
    }

    function _approve(address self, uint256 scope) internal {
        uint256 i = currentFrame;
        address target = _resolvedTarget(i);
        if (self != target) revert ApproveReverted("ADDRESS != resolved_target");
        uint256 allowed = _frames[i].flags & SCOPE_MASK;
        if (scope == 0 || scope & ~allowed != 0) revert ApproveReverted("scope not allowed by frame.flags");

        if (scope == SCOPE_EXECUTION) {
            if (senderApproved) revert ApproveReverted("sender already approved");
            if (target != sender) revert ApproveReverted("APPROVE_EXECUTION by a target other than tx.sender");
            senderApproved = true;
        } else if (scope == SCOPE_PAYMENT) {
            if (payer != address(0)) revert ApproveReverted("payer already set");
            if (target.balance < maxCost) revert ApproveReverted("payer balance below max_cost");
            if (!senderApproved) revert ApproveReverted("APPROVE_PAYMENT before the sender is approved");
            payer = target;
        } else {
            if (senderApproved || payer != address(0)) revert ApproveReverted("sender or payer already approved");
            if (target != sender) revert ApproveReverted("APPROVE_EXECUTION by a target other than tx.sender");
            if (target.balance < maxCost) revert ApproveReverted("payer balance below max_cost");
            senderApproved = true;
            payer = target;
        }
        _approvals.push(Approval(i, target, scope));
    }

    // --------------------------------------------------------------------------------------- introspection ------

    function _requireInFrame() internal view {
        if (!inFrame) revert FrameSimHalt("introspection outside a frame transaction");
    }

    /// TXPARAM (0xb0).
    function txParam(uint256 param) external view returns (uint256) {
        _requireInFrame();
        if (param == 0x00) return 0x06;
        if (param == 0x01) return nonce;
        if (param == 0x02) return uint256(uint160(sender));
        if (param == 0x03) return maxPriorityFeePerGas;
        if (param == 0x04) return maxFee;
        if (param == 0x06) return maxCost;
        if (param == 0x07) return blobCount;
        if (param == 0x08) return uint256(sigHash);
        if (param == 0x09) return _frames.length;
        if (param == 0x0a) return currentFrame;
        if (param == 0x0b) return _sigs.length;
        // The simulator does not meter state gas: it reports the frame's whole state limit.
        if (param == 0x0c) return _frames[currentFrame].state;
        if (param >= 0x0d && param <= 0x10) revert FrameSimUnsupported("TXPARAM (EIP-8250 keyed nonce)", param);
        revert FrameSimHalt("TXPARAM: undefined param");
    }

    /// FRAMEDATALOAD (0xb1): CALLDATALOAD semantics over frame `frameIndex`'s data.
    function frameDataLoad(uint256 offset, uint256 frameIndex) external view returns (bytes32 word) {
        _requireInFrame();
        bytes memory d = _frame(frameIndex).data;
        for (uint256 k; k < 32; k++) {
            if (offset + k < offset || offset + k >= d.length) break;
            word |= bytes32(uint256(uint8(d[offset + k])) << (8 * (31 - k)));
        }
    }

    /// FRAMEDATACOPY (0xb2): CALLDATACOPY semantics (zero-padded past the end).
    function frameDataCopy(uint256 dataOffset, uint256 length, uint256 frameIndex)
        external
        view
        returns (bytes memory)
    {
        _requireInFrame();
        return _copy(_frame(frameIndex).data, dataOffset, length);
    }

    /// FRAMEPARAM (0xb3).
    function frameParam(uint256 frameIndex, uint256 param) external view returns (uint256) {
        _requireInFrame();
        Frame storage f = _frame(frameIndex);
        if (param == 0x00) return uint256(uint160(_resolvedTarget(frameIndex)));
        if (param == 0x01) return f.execution;
        if (param == 0x02) return f.mode;
        if (param == 0x03) return f.flags;
        if (param == 0x04) return f.data.length;
        if (param == 0x05) return _status[_completed(frameIndex)];
        if (param == 0x06) return f.flags & SCOPE_MASK;
        if (param == 0x07) return (f.flags >> 2) & 0x01;
        if (param == 0x08) return f.value;
        if (param == 0x09) return f.state;
        if (param == 0x0a) return _gasUsed[_completed(frameIndex)];
        // The simulator does not meter state gas.
        if (param == 0x0b) {
            _completed(frameIndex);
            return 0;
        }
        revert FrameSimHalt("FRAMEPARAM: undefined param");
    }

    /// SIGPARAM (0xb4).
    function sigParam(uint256 sigIndex, uint256 param) external view returns (uint256) {
        _requireInFrame();
        Sig storage s = _sig(sigIndex);
        if (param == 0x00) {
            if (s.scheme == SCHEME_ARBITRARY) revert FrameSimHalt("SIGPARAM: RESOLVED_SIGNER of an ARBITRARY entry");
            return uint256(uint160(s.signer == address(0) ? sender : s.signer));
        }
        if (param == 0x01) return s.scheme;
        if (param == 0x02) return uint256(s.msgHash);
        if (param == 0x03) {
            if (s.scheme != SCHEME_ARBITRARY) revert FrameSimHalt("SIGPARAM: SIGNATURE_LENGTH of a validated scheme");
            return s.signature.length;
        }
        revert FrameSimHalt("SIGPARAM: undefined param");
    }

    /// SIGDATACOPY (0xb5): ARBITRARY entries only, zero-padded past the end.
    function sigDataCopy(uint256 dataOffset, uint256 length, uint256 sigIndex) external view returns (bytes memory) {
        _requireInFrame();
        Sig storage s = _sig(sigIndex);
        if (s.scheme != SCHEME_ARBITRARY) revert FrameSimHalt("SIGDATACOPY: not an ARBITRARY entry");
        return _copy(s.signature, dataOffset, length);
    }

    // ------------------------------------------------------------------------------------------- readers ------

    function frameCount() external view returns (uint256) {
        return _frames.length;
    }

    function sigCount() external view returns (uint256) {
        return _sigs.length;
    }

    function frameAt(uint256 i) external view returns (Frame memory) {
        return _frames[i];
    }

    function sigAt(uint256 i) external view returns (Sig memory) {
        return _sigs[i];
    }

    function resolvedTarget(uint256 i) external view returns (address) {
        return _resolvedTarget(i);
    }

    function statusOf(uint256 i) external view returns (uint8) {
        return _status[i];
    }

    function approvals() external view returns (Approval[] memory) {
        return _approvals;
    }

    // ------------------------------------------------------------------------------------------ internals ------

    function _frame(uint256 i) internal view returns (Frame storage) {
        if (i >= _frames.length) revert FrameSimHalt("frame index out of bounds");
        return _frames[i];
    }

    function _sig(uint256 i) internal view returns (Sig storage) {
        if (i >= _sigs.length) revert FrameSimHalt("signature index out of bounds");
        return _sigs[i];
    }

    function _completed(uint256 i) internal view returns (uint256) {
        _frame(i);
        if (i >= currentFrame) revert FrameSimHalt("FRAMEPARAM: status/gas of the current or a later frame");
        return i;
    }

    function _resolvedTarget(uint256 i) internal view returns (address) {
        address t = _frame(i).target;
        return t == address(0) ? sender : t;
    }

    function _copy(bytes memory src, uint256 offset, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 k; k < length; k++) {
            if (offset + k < offset || offset + k >= src.length) break;
            out[k] = src[offset + k];
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// A configurable EIP-8141 transaction for Foundry tests. The test EVM has no frame opcodes; FrameOps reaches each
/// opcode through a helper contract the FrameHelperHub created at a fixed nonce.
/// TxSim etches a forwarder at each helper address; every forwarder answers from one shared TxModel, the way the
/// opcode would answer for that transaction.
contract TxModel {
    struct Frame {
        uint8 mode; // 0 DEFAULT, 1 VERIFY, 2 SENDER
        address target; // address(0) = the sender
        uint256 value;
        bytes data;
        uint8 allowedScope; // flags & 3 (VERIFY frames)
        bool atomic;
    }

    struct Sig {
        uint8 scheme; // 0 ARBITRARY, 1 SECP256K1, 2 P256
        address signer; // protocol-resolved signer for SECP256K1/P256 (address(0) = the sender)
        bytes32 msg; // 0 = the tx signature hash
        bytes data; // ARBITRARY bytes (SIGDATACOPY); unused for protocol-verified schemes
    }

    address public sender;
    bytes32 public sigHash;
    uint256 public currentFrame;
    Frame[] internal frames;
    Sig[] internal sigs;

    function reset(address sender_, bytes32 sigHash_) external {
        sender = sender_;
        sigHash = sigHash_;
        delete frames;
        delete sigs;
        currentFrame = 0;
    }

    function addFrame(uint8 mode, address target, uint256 value, bytes calldata data) external {
        frames.push(Frame(mode, target, value, data, mode == 1 ? 3 : 0, false));
    }

    function setAllowedScope(uint256 i, uint8 scope) external {
        frames[i].allowedScope = scope;
    }

    function setAtomic(uint256 i, bool atomic) external {
        frames[i].atomic = atomic;
    }

    function addSig(uint8 scheme, address signer, bytes32 msg_, bytes calldata data) external {
        sigs.push(Sig(scheme, signer, msg_, data));
    }

    function setCurrentFrame(uint256 i) external {
        currentFrame = i;
    }

    // ---- answers ----

    function txparam(uint256 p) external view returns (uint256) {
        if (p == 2) return uint256(uint160(sender)); // SENDER
        if (p == 8) return uint256(sigHash); // SIG_HASH
        if (p == 9) return frames.length; // FRAME_COUNT
        if (p == 10) return currentFrame; // CURRENT_FRAME_INDEX
        if (p == 11) return sigs.length; // SIGNATURE_COUNT
        return 0;
    }

    function frameparam(uint256 i, uint256 p) external view returns (uint256) {
        Frame storage f = frames[i];
        if (p == 0) return uint256(uint160(f.target == address(0) ? sender : f.target)); // RESOLVED_TARGET
        if (p == 2) return f.mode; // MODE
        if (p == 4) return f.data.length; // DATA_LENGTH
        if (p == 6) return f.allowedScope; // ALLOWED_SCOPE
        if (p == 7) return f.atomic ? 1 : 0; // ATOMIC_BATCH
        if (p == 8) return f.value; // VALUE
        return 0;
    }

    function framedatacopy(uint256 offset, uint256 length, uint256 i) external view returns (bytes memory out) {
        bytes storage d = frames[i].data;
        out = new bytes(length);
        for (uint256 j; j < length; ++j) {
            if (offset + j < d.length) out[j] = d[offset + j];
        }
    }

    function sigparam(uint256 i, uint256 p) external view returns (uint256) {
        Sig storage s = sigs[i];
        if (p == 0) {
            require(s.scheme != 0, "RESOLVED_SIGNER of an ARBITRARY entry halts");
            return uint256(uint160(s.signer == address(0) ? sender : s.signer));
        }
        if (p == 1) return s.scheme;
        if (p == 2) return uint256(s.msg);
        require(s.scheme == 0, "SIGNATURE_LENGTH of a protocol-verified entry halts");
        return s.data.length;
    }

    function sigdatacopy(uint256 offset, uint256 length, uint256 i) external view returns (bytes memory out) {
        require(sigs[i].scheme == 0, "SIGDATACOPY of a protocol-verified entry");
        bytes storage d = sigs[i].data;
        out = new bytes(length);
        for (uint256 j; j < length; ++j) {
            if (offset + j < d.length) out[j] = d[offset + j];
        }
    }
}

/// The code etched at one helper address: decodes that opcode's operands and asks the model.
contract TxSimForwarder {
    TxModel internal immutable MODEL;
    uint8 internal immutable OP; // 2 txparam, 3 framedataload, 4 framedatacopy, 5 frameparam, 6 sigparam, 7 sigdatacopy

    constructor(TxModel model, uint8 op) {
        MODEL = model;
        OP = op;
    }

    fallback() external payable {
        bytes memory out;
        if (OP == 2) {
            out = abi.encode(MODEL.txparam(abi.decode(msg.data, (uint256))));
        } else if (OP == 3) {
            (uint256 offset, uint256 i) = abi.decode(msg.data, (uint256, uint256));
            out = abi.encode(bytes32(MODEL.framedatacopy(offset, 32, i)));
        } else if (OP == 4) {
            (uint256 offset, uint256 len, uint256 i) = abi.decode(msg.data, (uint256, uint256, uint256));
            out = MODEL.framedatacopy(offset, len, i);
        } else if (OP == 5) {
            (uint256 i, uint256 p) = abi.decode(msg.data, (uint256, uint256));
            out = abi.encode(MODEL.frameparam(i, p));
        } else if (OP == 6) {
            (uint256 i, uint256 p) = abi.decode(msg.data, (uint256, uint256));
            out = abi.encode(MODEL.sigparam(i, p));
        } else {
            (uint256 offset, uint256 len, uint256 i) = abi.decode(msg.data, (uint256, uint256, uint256));
            out = MODEL.sigdatacopy(offset, len, i);
        }
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}

/// APPROVE, delegatecalled from the account: records the scope as an event of the account.
contract SimApprove {
    event Approved(uint256 scope);

    fallback() external payable {
        emit Approved(abi.decode(msg.data, (uint256)));
    }
}

abstract contract TxSim is Test {
    TxModel internal txm;

    /// Wires the helpers `host` (a FrameHelperHub) created at nonces 1..7 to one TxModel.
    function wireTxSim(address host) internal {
        if (address(txm) == address(0)) txm = new TxModel(); // one model shared by every host
        vm.etch(vm.computeCreateAddress(host, 1), address(new SimApprove()).code);
        for (uint8 op = 2; op <= 7; ++op) {
            vm.etch(vm.computeCreateAddress(host, op), address(new TxSimForwarder(txm, op)).code);
        }
    }
}

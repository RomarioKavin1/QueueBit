// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// Contracts that exercise FrameSim. They are test fixtures, not LEAKED contracts.

contract Foreign {
    uint256 public value = 1;
}

/// A wallet with one owner key, a self-call `execute`, and VERIFY entry points that each exercise one rule.
contract SimWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public owner;
    uint256 public counter;

    error NotOwnerSignature();
    error NotSelf();
    error BadWitness();
    error BadNextFrame();

    constructor(address owner_) payable {
        owner = owner_;
    }

    receive() external payable {}

    /// Signature entry 0 must be a SECP256K1 signature by `owner`; approves the frame's whole allowed scope.
    function verifyFrame() external {
        if (sigparam(0, SigParam.SCHEME) != 1) revert NotOwnerSignature();
        if (address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) != owner) revert NotOwnerSignature();
        approve(Scope(frameparam(txparam(TxParam.CURRENT_FRAME_INDEX), FrameParam.ALLOWED_SCOPE)));
    }

    /// Approves an explicit scope, whatever the frame allows.
    function verifyWithScope(Scope scope) external {
        approve(scope);
    }

    function approveTwice() external {
        approve(Scope.EXECUTION);
        approve(Scope.EXECUTION);
    }

    /// Writes storage in VERIFY: not static.
    function verifyAndWrite() external {
        counter++;
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Reads another contract's storage in VERIFY.
    function verifyReadingForeign(Foreign other) external {
        require(other.value() == 1);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    event Verified(uint256 frame);

    /// Emits a log in VERIFY: LOG is not allowed in a STATICCALL.
    function verifyAndEmit() external {
        emit Verified(txparam(TxParam.CURRENT_FRAME_INDEX));
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Reads another account's balance in VERIFY (BALANCE is banned in the validation prefix; so is SELFBALANCE,
    /// which Foundry does not record).
    function verifyReadingBalance(address who) external {
        require(who.balance > 0);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Calls an address without code in VERIFY (CALL* to a non-contract is rejected by the public mempool).
    function verifyCallingNoCode(address who) external {
        (bool ok,) = who.staticcall("");
        require(ok);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// A bespoke scheme in an ARBITRARY entry: witness = abi.encode(sigHash, owner).
    function verifyArbitrary() external {
        uint256 len = sigparam(0, SigParam.SIGNATURE_LENGTH);
        bytes memory witness = sigdatacopy(0, len, 0);
        if (keccak256(witness) != keccak256(abi.encode(bytes32(txparam(TxParam.SIG_HASH)), owner))) {
            revert BadWitness();
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Requires the next frame to be a SENDER frame to this wallet calling `execute`.
    function verifyWalk() external {
        uint256 next = txparam(TxParam.CURRENT_FRAME_INDEX) + 1;
        if (next >= txparam(TxParam.FRAME_COUNT)) revert BadNextFrame();
        if (frameparam(next, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert BadNextFrame();
        if (address(uint160(frameparam(next, FrameParam.RESOLVED_TARGET))) != address(this)) revert BadNextFrame();
        if (bytes4(framedataload(0, next)) != this.execute.selector) revert BadNextFrame();
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    function execute(address to, uint256 value, bytes calldata data) external payable {
        if (msg.sender != address(this)) revert NotSelf();
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function bump() external payable {
        counter++;
    }

    function failing() external pure {
        revert("failing");
    }

    // Introspection views, for direct calls inside `simEnter`.
    function tp(TxParam p) external view returns (uint256) {
        return txparam(p);
    }

    function fp(uint256 i, FrameParam p) external view returns (uint256) {
        return frameparam(i, p);
    }

    function sp(uint256 i, SigParam p) external view returns (uint256) {
        return sigparam(i, p);
    }

    function fdl(uint256 offset, uint256 i) external view returns (bytes32) {
        return framedataload(offset, i);
    }

    function fdc(uint256 offset, uint256 length, uint256 i) external view returns (bytes memory) {
        return framedatacopy(offset, length, i);
    }

    function sdc(uint256 offset, uint256 length, uint256 i) external view returns (bytes memory) {
        return sigdatacopy(offset, length, i);
    }
}

/// Pays for anyone: approves PAYMENT.
contract SimPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    constructor() payable {}

    function verifyFrame() external {
        approve(Scope.PAYMENT);
    }
}

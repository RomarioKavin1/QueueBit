// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LeanPoolHotSigner} from "./LeanPoolHotSigner.sol";

/// @title LeanPoolHotSignerFactory
/// @notice Stateless CREATE2 factory for `LeanPoolHotSigner` clones. A clone is fully determined by its immutable
///         args (`account ‖ registry ‖ aggregator ‖ pk ‖ maxFee`); the salt is their hash, so anyone may deploy a
///         given signer and only that signer, and creating it twice returns the existing one.
contract LeanPoolHotSignerFactory {
    /// The implementation every clone delegates to (holds the opcode helpers and the fee parameter).
    LeanPoolHotSigner public immutable implementation;
    /// The `DepsRegistry` every signer of this factory reads.
    address public immutable registry;

    event HotSignerCreated(address indexed signer, address indexed account, address indexed aggregator, bytes32 pk);

    error InvalidConfig();

    constructor(Devnet devnet_, TxParam feeParam_, address registry_) {
        if (registry_.code.length == 0) revert InvalidConfig();
        registry = registry_;
        implementation = new LeanPoolHotSigner(devnet_, feeParam_);
    }

    /// Deploys (or returns the existing) signer. Payable: `msg.value` funds the signer's gas.
    function createHotSigner(address account, address aggregator, bytes32 pk, uint96 maxFee)
        external
        payable
        returns (address signer)
    {
        if (account == address(0) || aggregator == address(0) || pk == bytes32(0) || maxFee == 0) {
            revert InvalidConfig();
        }
        bytes memory args = _args(account, aggregator, pk, maxFee);
        bool existed;
        (existed, signer) = LibClone.createDeterministicClone(msg.value, address(implementation), args, keccak256(args));
        if (!existed) emit HotSignerCreated(signer, account, aggregator, pk);
    }

    function predictHotSigner(address account, address aggregator, bytes32 pk, uint96 maxFee)
        external
        view
        returns (address)
    {
        bytes memory args = _args(account, aggregator, pk, maxFee);
        return LibClone.predictDeterministicAddress(address(implementation), args, keccak256(args), address(this));
    }

    /// The layout `LeanPoolHotSigner._args` reads (104 bytes).
    function _args(address account, address aggregator, bytes32 pk, uint96 maxFee)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(account, registry, aggregator, pk, maxFee);
    }
}

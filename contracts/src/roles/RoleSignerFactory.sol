// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {IStakingRegistry} from "../interfaces/IStakingRegistry.sol";
import {PQRoleSigner} from "./PQRoleSigner.sol";

/// @title RoleSignerFactory
/// @notice Stateless CREATE2 factory for `PQRoleSigner` instances (the `VaultSigner` / `RecoverySigner` configs of
///         an account), with the `createRoleSigner` signature of plan §10.3.1. The chain-level settings (opcode
///         helper set, fee parameter, staking registry, initial fee bound) are this factory's immutables, so one
///         factory per chain profile. `GuardianSigner` instances are deployed directly (script), not from here,
///         to keep this factory under the code-size limit.
/// @dev    Each instance deploys its own 7 opcode helpers in its constructor (`HegotaSupport`): ~20M gas on the
///         Amsterdam+ devnet; give the creating transaction 25-30M gas. The salt is mixed with every argument, so a
///         front-runner cannot occupy an address with different parameters.
contract RoleSignerFactory {
    Devnet public immutable devnet;
    TxParam public immutable feeParam;
    IStakingRegistry public immutable stakingRegistry;
    uint256 public immutable defaultMaxFee;

    event RoleSignerCreated(address indexed signer, uint8 role, address indexed account);

    error InvalidConfig();

    constructor(Devnet devnet_, TxParam feeParam_, IStakingRegistry stakingRegistry_, uint256 defaultMaxFee_) {
        // `PQRoleSigner`'s constructor rejects any other fee parameter: a factory built with one would deploy at
        // ~16M gas and then fail every `createRoleSigner` with "create2 failed".
        if (feeParam_ != TxParam.MAX_FEE && feeParam_ != TxParam.MAX_COST) revert InvalidConfig();
        devnet = devnet_;
        feeParam = feeParam_;
        stakingRegistry = stakingRegistry_;
        defaultMaxFee = defaultMaxFee_;
    }

    /// Deploys (or returns the existing) signer for these parameters. Payable: `msg.value` funds the new signer.
    function createRoleSigner(
        bytes32 salt,
        uint8 role,
        address account,
        bytes32 pk,
        address pqVerifier,
        address payerKey
    ) external payable returns (address signer) {
        bytes memory initCode = _initCode(role, account, pk, pqVerifier, payerKey);
        bytes32 s = _salt(salt, role, account, pk, pqVerifier, payerKey);
        signer = _predict(s, initCode);
        if (signer.code.length != 0) {
            if (msg.value != 0) {
                (bool ok,) = signer.call{value: msg.value}("");
                require(ok);
            }
            return signer;
        }
        assembly ("memory-safe") {
            signer := create2(callvalue(), add(initCode, 0x20), mload(initCode), s)
        }
        require(signer != address(0), "create2 failed");
        emit RoleSignerCreated(signer, role, account);
    }

    function predictRoleSigner(
        bytes32 salt,
        uint8 role,
        address account,
        bytes32 pk,
        address pqVerifier,
        address payerKey
    ) external view returns (address) {
        return _predict(
            _salt(salt, role, account, pk, pqVerifier, payerKey), _initCode(role, account, pk, pqVerifier, payerKey)
        );
    }

    function _initCode(uint8 role, address account, bytes32 pk, address pqVerifier, address payerKey)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(PQRoleSigner).creationCode,
            abi.encode(
                devnet, account, role, IPQVerifier(pqVerifier), pk, payerKey, defaultMaxFee, feeParam, stakingRegistry
            )
        );
    }

    function _salt(bytes32 salt, uint8 role, address account, bytes32 pk, address pqVerifier, address payerKey)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(salt, role, account, pk, pqVerifier, payerKey));
    }

    function _predict(bytes32 s, bytes memory initCode) private view returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), s, keccak256(initCode))))));
    }
}

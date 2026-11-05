// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {IStakingRegistry} from "../interfaces/IStakingRegistry.sol";
import {PQRoleSigner} from "./PQRoleSigner.sol";

/// @title RoleSignerFactory
/// @notice Stateless CREATE2 factory for `PQRoleSigner` instances (the `VaultSigner` / `RecoverySigner` configs of
///         an account), with the `createRoleSigner` signature of plan §10.3.1. Each instance is a Solady ERC-1167
///         clone with immutable args (`account ‖ verifier ‖ pk ‖ sigLength ‖ role`, read from the clone's code in
///         VERIFY, no SLOAD) of one `PQRoleSigner` implementation that this factory deploys in its constructor and
///         that holds the opcode helpers and the chain settings. The chain-level settings (opcode helper set, fee
///         parameter, staking registry, initial fee bound) are this factory's immutables, so one factory per chain
///         profile; `FeeProfile` rejects a fee parameter that is not a total-wei budget on that profile, so a
///         mismatched factory fails to deploy. `GuardianSigner` instances are deployed directly (script).
/// @dev    Cost: the factory deploy carries the implementation (its 7 opcode-helper CREATEs, ~16M gas on the
///         Amsterdam+ devnet); an instance is a 150-byte clone plus one storage slot (`payerKey`, `maxFee`).
///         Front-running: the clone's init code holds every immutable arg and the CREATE2 salt mixes the caller's
///         salt with every argument (including `payerKey`, which lives in storage), and `initialize` runs in the
///         same call and only from this factory, so a front-runner can only deploy the identical signer.
contract RoleSignerFactory {
    Devnet public immutable devnet;
    TxParam public immutable feeParam;
    IStakingRegistry public immutable stakingRegistry;
    uint256 public immutable defaultMaxFee;
    /// The implementation every clone delegates to.
    PQRoleSigner public immutable implementation;

    event RoleSignerCreated(address indexed signer, uint8 role, address indexed account);

    error InvalidConfig();

    constructor(Devnet devnet_, TxParam feeParam_, IStakingRegistry stakingRegistry_, uint256 defaultMaxFee_) {
        if (defaultMaxFee_ > type(uint96).max) revert InvalidConfig();
        devnet = devnet_;
        feeParam = feeParam_;
        stakingRegistry = stakingRegistry_;
        defaultMaxFee = defaultMaxFee_;
        // Reverts `FeeProfile.FeeParamMismatch` for a fee parameter the devnet does not read as a total budget.
        implementation = new PQRoleSigner(devnet_, feeParam_, stakingRegistry_);
    }

    /// Deploys (or returns the existing) signer for these parameters. Payable: `msg.value` funds the signer.
    /// @param account the LEAKED account the signer serves, or address(0) for an unbound signer (it then serves any
    ///        account whose `getRoles()` names it in its role; needed for a vault signer whose account's address
    ///        commits to it, see `PQRoleSigner`).
    function createRoleSigner(
        bytes32 salt,
        uint8 role,
        address account,
        bytes32 pk,
        address pqVerifier,
        address payerKey
    ) external payable returns (address signer) {
        uint256 len = _sigLength(pqVerifier);
        if ((role != 1 && role != 2) || pk == bytes32(0) || len == 0) revert InvalidConfig();
        bool existed;
        (existed, signer) = LibClone.createDeterministicClone(
            msg.value,
            address(implementation),
            _args(role, account, pk, pqVerifier, len),
            _salt(salt, role, account, pk, pqVerifier, payerKey)
        );
        if (existed) return signer;
        PQRoleSigner(payable(signer)).initialize(payerKey, defaultMaxFee);
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
        return LibClone.predictDeterministicAddress(
            address(implementation),
            _args(role, account, pk, pqVerifier, _sigLength(pqVerifier)),
            _salt(salt, role, account, pk, pqVerifier, payerKey),
            address(this)
        );
    }

    /// The clone's immutable args, in the layout `PQRoleSigner._args` reads (105 bytes).
    function _args(uint8 role, address account, bytes32 pk, address pqVerifier, uint256 len)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(account, pqVerifier, pk, len, role);
    }

    function _salt(bytes32 salt, uint8 role, address account, bytes32 pk, address pqVerifier, address payerKey)
        private
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(salt, role, account, pk, pqVerifier, payerKey, defaultMaxFee));
    }

    /// `verifier.sigLength()`, or 0 when the verifier has no code or does not answer (fixed-length schemes only).
    function _sigLength(address pqVerifier) private view returns (uint256 len) {
        if (pqVerifier.code.length == 0) return 0;
        (bool ok, bytes memory ret) = pqVerifier.staticcall(abi.encodeCall(IPQVerifier.sigLength, ()));
        if (ok && ret.length >= 32) len = abi.decode(ret, (uint256));
        if (len > type(uint16).max) len = 0;
    }
}

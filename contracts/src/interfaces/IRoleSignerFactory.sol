// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IRoleSignerFactory
/// @notice The part of `src/roles/RoleSignerFactory.sol` the account uses: `initialize` derives a bound role signer's
///         address with `predictRoleSigner` (no deployment; anyone deploys the clone later with `createRoleSigner`
///         and the same arguments). `test/roles/RoleSurfaceParity.t.sol` asserts selector parity.
interface IRoleSignerFactory {
    /// Role ids, as `PQRoleSigner.ROLE_VAULT` / `ROLE_RECOVERY`.
    function predictRoleSigner(
        bytes32 salt,
        uint8 role,
        address account,
        bytes32 pk,
        address pqVerifier,
        address payerKey
    ) external view returns (address);

    function createRoleSigner(
        bytes32 salt,
        uint8 role,
        address account,
        bytes32 pk,
        address pqVerifier,
        address payerKey
    ) external payable returns (address signer);
}

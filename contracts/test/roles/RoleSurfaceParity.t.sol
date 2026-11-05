// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ILeakedAccountRoles as R} from "../../src/interfaces/ILeakedAccountRoles.sol";
import {LeakedAccountRoles as A} from "../../src/account/LeakedAccountRoles.sol";
import {IRoleSignerFactory as IF} from "../../src/interfaces/IRoleSignerFactory.sol";
import {RoleSignerFactory as F} from "../../src/roles/RoleSignerFactory.sol";

/// `ILeakedAccountRoles` (what the role signers' tests and scripts encode against) must name exactly the selectors
/// the account's role module implements. A mismatch here means a role signer would forward calldata the account
/// rejects as an unknown selector.
contract RoleSurfaceParityTest is Test {
    function test_selectors_matchLeakedAccountRoles() public pure {
        assertEq(R.vaultExecute.selector, A.vaultExecute.selector);
        assertEq(R.vaultQueue.selector, A.vaultQueue.selector);
        assertEq(R.vaultCancel.selector, A.vaultCancel.selector);
        assertEq(R.vaultSetHotKey.selector, A.vaultSetHotKey.selector);
        assertEq(R.vaultSetCap.selector, A.vaultSetCap.selector);
        assertEq(R.vaultSetFeePolicy.selector, A.vaultSetFeePolicy.selector);
        assertEq(R.vaultSetToken.selector, A.vaultSetToken.selector);
        assertEq(R.vaultSetTarget.selector, A.vaultSetTarget.selector);
        assertEq(R.vaultSetSession.selector, A.vaultSetSession.selector);
        assertEq(R.vaultSetRecipientMode.selector, A.vaultSetRecipientMode.selector);
        assertEq(R.vaultSetValueVerifier.selector, A.vaultSetValueVerifier.selector);
        assertEq(R.vaultSetTrustedVerifier.selector, A.vaultSetTrustedVerifier.selector);
        assertEq(R.vaultSetTimelock.selector, A.vaultSetTimelock.selector);
        assertEq(R.vaultSetRecoverySigner.selector, A.vaultSetRecoverySigner.selector);
        assertEq(R.vaultSetGuardian.selector, A.vaultSetGuardian.selector);
        assertEq(R.vaultFreeze.selector, A.vaultFreeze.selector);
        assertEq(R.vaultUnfreeze.selector, A.vaultUnfreeze.selector);
        assertEq(R.vaultExtendFreeze.selector, A.vaultExtendFreeze.selector);
        assertEq(R.vaultEnableBunker.selector, A.vaultEnableBunker.selector);
        assertEq(R.vaultQueueUpgrade.selector, A.vaultQueueUpgrade.selector);
        assertEq(R.vaultQueueMigrate.selector, A.vaultQueueMigrate.selector);
        assertEq(R.recoveryCancel.selector, A.recoveryCancel.selector);
        assertEq(R.recoveryStartVaultRotation.selector, A.recoveryStartVaultRotation.selector);
        assertEq(R.recoveryFinalizeVaultRotation.selector, A.recoveryFinalizeVaultRotation.selector);
        assertEq(R.recoveryCancelVaultRotation.selector, A.recoveryCancelVaultRotation.selector);
        assertEq(R.guardianFreeze.selector, A.guardianFreeze.selector);
        assertEq(R.executeQueued.selector, A.executeQueued.selector);
        assertEq(R.executeUpgrade.selector, A.executeUpgrade.selector);
        assertEq(R.executeMigrate.selector, A.executeMigrate.selector);
        assertEq(R.getRoles.selector, A.getRoles.selector);
        assertEq(R.getVaultBucket.selector, A.getVaultBucket.selector);
        assertEq(R.isQueued.selector, A.isQueued.selector);
        assertEq(R.isValueVerifier.selector, A.isValueVerifier.selector);
        assertEq(R.isTrustedVerifier.selector, A.isTrustedVerifier.selector);
    }

    /// What `LeakedAccountImpl.initialize` calls to derive a bound role signer.
    function test_selectors_matchRoleSignerFactory() public pure {
        assertEq(IF.predictRoleSigner.selector, F.predictRoleSigner.selector);
        assertEq(IF.createRoleSigner.selector, F.createRoleSigner.selector);
    }
}

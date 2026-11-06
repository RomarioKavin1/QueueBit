// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {HotExecuteTest} from "../account/HotExecute.t.sol";
import {ParityHotSigner} from "./LeanPoolHotPath.t.sol";

/// Every `HotExecuteTest` case again, with each hot batch arriving through `hotExecuteFrom` from the Vault-installed
/// PQ hot signer instead of `hotExecute` from the account itself: the two entry points must enforce the same limits.
contract HotExecuteFromParityTest is HotExecuteTest {
    address internal pqSigner;

    function setUp() public override {
        super.setUp();
        pqSigner = address(new ParityHotSigner(address(account)));
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetPQHotSigner, (pqSigner)));
    }

    /// Lockdown removes the PQ signer (vaultEnableBunker clears it), so it is refused as a stranger: stronger than the
    /// hot key's BunkerActive, and it stays refused after a new hot key clears bunker.
    function test_revert_bunker() public override {
        vm.prank(vault);
        roles.vaultEnableBunker();
        vm.expectRevert(IQueueBitAccount.Unauthorized.selector);
        _hot(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
    }

    function _hot(uint256 declared, IQueueBitAccount.Call[] memory calls) internal override {
        vm.prank(pqSigner);
        account.hotExecuteFrom(declared, calls);
    }
}

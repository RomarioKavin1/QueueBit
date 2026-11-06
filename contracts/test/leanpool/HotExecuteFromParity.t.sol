// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {HotExecuteTest} from "../account/HotExecute.t.sol";
import {ParityHotSigner} from "./LeanPoolHotPath.t.sol";

/// Every `HotExecuteTest` case again, with each hot batch arriving through `hotExecuteFrom` from the Vault-installed
/// PQ hot signer instead of `hotExecute` from the account itself: the two entry points must enforce the same limits.
contract HotExecuteFromParityTest is HotExecuteTest {
    address internal pqSigner;

    function setUp() public override {
        super.setUp();
        pqSigner = address(new ParityHotSigner(address(account)));
        vm.prank(vault);
        roles.vaultSetPQHotSigner(pqSigner);
    }

    function _hot(uint256 declared, IQueueBitAccount.Call[] memory calls) internal override {
        vm.prank(pqSigner);
        account.hotExecuteFrom(declared, calls);
    }
}

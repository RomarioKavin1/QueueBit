// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {AccountFactory} from "../../src/account/AccountFactory.sol";
import {ILeakedAccount} from "../../src/account/ILeakedAccount.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {AccountTestBase} from "./AccountTestBase.sol";

contract AccountFactoryTest is AccountTestBase {
    function test_predictMatchesCreate_andIdempotent() public {
        bytes memory init = _initData(_defaultCfg());
        address p = factory.predictAccount(bytes32(uint256(7)), address(impl), init);
        vm.expectEmit(address(factory));
        emit AccountFactory.AccountCreated(p, address(impl), bytes32(uint256(7)));
        address a = factory.createAccount(bytes32(uint256(7)), address(impl), init);
        assertEq(a, p);
        assertGt(a.code.length, 0);
        // a second (front-run) submission returns the same account without reverting
        assertEq(factory.createAccount(bytes32(uint256(7)), address(impl), init), a);
        bytes32 implSlot = vm.load(a, ERC1967Utils.IMPLEMENTATION_SLOT);
        assertEq(address(uint160(uint256(implSlot))), address(impl));
    }

    function test_initDataBindsAddress() public view {
        ILeakedAccount.InitConfig memory c = _defaultCfg();
        address a1 = factory.predictAccount(bytes32(uint256(7)), address(impl), _initData(c));
        c.hotKey = stranger;
        address a2 = factory.predictAccount(bytes32(uint256(7)), address(impl), _initData(c));
        assertTrue(a1 != a2, "a front-runner cannot install other keys at the same address");
    }

    function test_emptyInitDataRefused() public {
        vm.expectRevert(AccountFactory.EmptyInitData.selector);
        factory.createAccount(bytes32(0), address(impl), "");
    }

    function testFuzz_accountIsNeverTheHotKeyEOA_C3(uint256 pk, bytes32 salt) public {
        pk = bound(pk, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        ILeakedAccount.InitConfig memory c = _defaultCfg();
        c.hotKey = vm.addr(pk);
        address a = factory.createAccount(salt, address(impl), _initData(c));
        assertTrue(a != vm.addr(pk));
        assertEq(LeakedAccountImpl(payable(a)).getHotConfig().hotKey, vm.addr(pk));
    }

    function test_factoryIsStateless() public {
        vm.record();
        factory.createAccount(bytes32(uint256(8)), address(impl), _initData(_defaultCfg()));
        (, bytes32[] memory writes) = vm.accesses(address(factory));
        assertEq(writes.length, 0);
    }
}

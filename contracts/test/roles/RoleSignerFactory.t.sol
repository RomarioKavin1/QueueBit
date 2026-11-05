// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {IStakingRegistry} from "../../src/interfaces/IStakingRegistry.sol";
import {PQRoleSigner} from "../../src/roles/PQRoleSigner.sol";
import {RoleSignerFactory} from "../../src/roles/RoleSignerFactory.sol";

contract RoleSignerFactoryTest is Test {
    RoleSignerFactory internal f;
    C13Verifier internal verifier;
    address internal account = makeAddr("account");
    address internal payer = makeAddr("payer");
    IStakingRegistry internal registry = IStakingRegistry(makeAddr("registry"));
    bytes32 internal constant PK = 0x768f0f9dcb33d65e986c130b9264a2acf845b61356ca435aa49c39d525967753;

    function setUp() public {
        verifier = new C13Verifier();
        f = new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_COST, registry, 0.05 ether);
    }

    function test_createMatchesPredict_vaultAndRecovery() public {
        address pv = f.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer);
        address v = f.createRoleSigner{value: 1 ether}(bytes32(0), 1, account, PK, address(verifier), payer);
        assertEq(v, pv);
        assertEq(v.balance, 1 ether);
        PQRoleSigner s = PQRoleSigner(payable(v));
        assertEq(s.account(), account);
        assertEq(s.role(), 1);
        assertEq(s.pk(), PK);
        assertEq(s.payerKey(), payer);
        assertEq(s.maxFee(), 0.05 ether);
        assertEq(s.sigLength(), 3688);
        assertEq(uint256(s.feeParam()), uint256(TxParam.MAX_COST));
        assertEq(address(s.stakingRegistry()), address(registry));

        address r = f.createRoleSigner(bytes32(0), 2, account, PK, address(verifier), address(0));
        assertTrue(r != v);
        assertEq(PQRoleSigner(payable(r)).role(), 2);
        assertEq(PQRoleSigner(payable(r)).payerKey(), address(0));
    }

    function test_idempotent_andTopsUp() public {
        address a = f.createRoleSigner(bytes32(uint256(7)), 1, account, PK, address(verifier), payer);
        address b = f.createRoleSigner{value: 2 wei}(bytes32(uint256(7)), 1, account, PK, address(verifier), payer);
        assertEq(a, b);
        assertEq(b.balance, 2 wei);
    }

    function test_saltBindsParameters() public {
        address a = f.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer);
        address b = f.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), makeAddr("otherPayer"));
        assertTrue(a != b);
        assertTrue(a != f.predictRoleSigner(bytes32(0), 1, makeAddr("otherAccount"), PK, address(verifier), payer));
        assertTrue(a != f.predictRoleSigner(bytes32(0), 1, account, ~PK, address(verifier), payer));
        assertTrue(a != f.predictRoleSigner(bytes32(0), 1, account, PK, makeAddr("otherVerifier"), payer));
        assertTrue(a != f.predictRoleSigner(bytes32(uint256(1)), 1, account, PK, address(verifier), payer));
    }

    /// Front-running `createRoleSigner` is harmless: every parameter is in the CREATE2 address, so the only thing a
    /// front-runner can deploy at the predicted address is the identical signer (and its ETH goes to it).
    function test_frontRun_sameParameters_sameSigner() public {
        address predicted = f.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer);
        vm.prank(makeAddr("frontRunner"));
        address first = f.createRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer);
        address second = f.createRoleSigner{value: 1 ether}(bytes32(0), 1, account, PK, address(verifier), payer);
        assertEq(first, predicted);
        assertEq(second, predicted);
        assertEq(predicted.balance, 1 ether);
        assertEq(PQRoleSigner(payable(predicted)).payerKey(), payer);
    }

    /// The chain-profile settings are the factory's immutables, so two factories never share an address space.
    function test_differentFactorySettings_differentAddress() public {
        RoleSignerFactory g = new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_FEE, registry, 0.05 ether);
        assertTrue(
            f.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer)
                != g.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer)
        );
    }

    function test_create_badSignerConfig_reverts() public {
        vm.expectRevert(bytes("create2 failed"));
        f.createRoleSigner(bytes32(0), 1, account, bytes32(0), address(verifier), payer);
        vm.expectRevert(bytes("create2 failed"));
        f.createRoleSigner(bytes32(0), 3, account, PK, address(verifier), payer);
        vm.expectRevert(bytes("create2 failed"));
        f.createRoleSigner(bytes32(0), 1, account, PK, makeAddr("noCode"), payer);
    }

    function test_constructor_rejectsBadFeeParam() public {
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_PRIORITY_FEE_PER_GAS, registry, 0.05 ether);
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.SIG_HASH, registry, 0.05 ether);
        // both profiles' fee parameters are accepted
        new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_FEE, registry, 0.05 ether);
    }
}

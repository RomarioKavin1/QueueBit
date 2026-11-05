// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {IStakingRegistry} from "../../src/interfaces/IStakingRegistry.sol";
import {PQRoleSigner} from "../../src/roles/PQRoleSigner.sol";
import {RoleSignerFactory} from "../../src/roles/RoleSignerFactory.sol";
import {FeeProfile} from "../../src/roles/FeeProfile.sol";

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
        RoleSignerFactory g = new RoleSignerFactory(Devnet.EIP7906_WORKSHOP, TxParam.MAX_COST, registry, 0.05 ether);
        assertTrue(
            f.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer)
                != g.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer)
        );
    }

    function test_create_badSignerConfig_reverts() public {
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        f.createRoleSigner(bytes32(0), 1, account, bytes32(0), address(verifier), payer);
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        f.createRoleSigner(bytes32(0), 3, account, PK, address(verifier), payer);
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        f.createRoleSigner(bytes32(0), 1, account, PK, makeAddr("noCode"), payer);
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        f.createRoleSigner(bytes32(0), 0, account, PK, address(verifier), payer);
    }

    /// The deploy-time fee-parameter assertion (`FeeProfile`): on the chain-1337 profile (ethrex
    /// `eip8141-tracer`, TXPARAM 0x04 per-gas) only MAX_COST is a total budget, so a MAX_FEE factory fails to
    /// deploy; a parameter that is no fee at all fails on every profile.
    function test_constructor_feeProfileAssertion() public {
        vm.expectRevert(
            abi.encodeWithSelector(FeeProfile.FeeParamMismatch.selector, Devnet.ERC8421_WORKSHOP, TxParam.MAX_FEE)
        );
        new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_FEE, registry, 0.05 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeProfile.FeeParamMismatch.selector, Devnet.ERC8421_WORKSHOP, TxParam.MAX_PRIORITY_FEE_PER_GAS
            )
        );
        new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_PRIORITY_FEE_PER_GAS, registry, 0.05 ether);
        vm.expectRevert(
            abi.encodeWithSelector(FeeProfile.FeeParamMismatch.selector, Devnet.EIP7906_WORKSHOP, TxParam.SIG_HASH)
        );
        new RoleSignerFactory(Devnet.EIP7906_WORKSHOP, TxParam.SIG_HASH, registry, 0.05 ether);
        // the 7906 workshop chain is not probed yet: both total-budget parameters pass there
        new RoleSignerFactory(Devnet.EIP7906_WORKSHOP, TxParam.MAX_FEE, registry, 0.05 ether);
        new RoleSignerFactory(Devnet.EIP7906_WORKSHOP, TxParam.MAX_COST, registry, 0.05 ether);
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_COST, registry, uint256(type(uint96).max) + 1);
    }

    /// The clone target: < 300k gas per instance (measured here without Amsterdam+ state gas; the devnet run in
    /// `devnet-tests/g1` records the chain figure), 150 bytes of code, the implementation shared.
    function test_cloneCost_andShape() public {
        uint256 g0 = gasleft();
        address v = f.createRoleSigner(bytes32(uint256(42)), 1, account, PK, address(verifier), payer);
        uint256 used = g0 - gasleft();
        assertLt(used, 300_000, "instance gas");
        assertEq(v.code.length, 0x2d + 105);
        address r = f.createRoleSigner(bytes32(uint256(42)), 2, account, PK, address(verifier), payer);
        // both clones delegate to the one implementation (its address is in the proxy code)
        assertEq(address(uint160(bytes20(_slice(v.code, 10, 20)))), address(f.implementation()));
        assertEq(address(uint160(bytes20(_slice(r.code, 10, 20)))), address(f.implementation()));
    }

    function test_unbound_signer() public {
        address u = f.createRoleSigner(bytes32(0), 1, address(0), PK, address(verifier), payer);
        assertEq(PQRoleSigner(payable(u)).account(), address(0));
        assertTrue(u != f.predictRoleSigner(bytes32(0), 1, account, PK, address(verifier), payer));
    }

    function test_maxFeeBoundInSalt() public {
        RoleSignerFactory g = new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_COST, registry, 0.06 ether);
        // same chain settings but a different default bound: a different factory, a different address space anyway;
        // the bound is also mixed into the salt, so the storage half of the config is committed too
        assertEq(
            PQRoleSigner(payable(g.createRoleSigner(0, 1, account, PK, address(verifier), payer))).maxFee(), 0.06 ether
        );
    }

    function _slice(bytes memory b, uint256 start, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[start + i];
        }
    }
}

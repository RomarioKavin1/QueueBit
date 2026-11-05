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
    }
}

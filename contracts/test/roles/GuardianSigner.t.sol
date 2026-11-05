// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FrameSim} from "../frame/FrameSim.sol";
import {ILeakedAccountRoles} from "../../src/interfaces/ILeakedAccountRoles.sol";
import {GuardianSigner} from "../../src/roles/GuardianSigner.sol";
import {MockLeakedAccount} from "./RoleMocks.sol";

contract GuardianSignerTest is FrameSim {
    MockLeakedAccount internal account;
    GuardianSigner internal g;
    address internal key;
    uint256 internal keyPk;

    uint256 internal constant MAX_FEE = 0.01 ether;

    function setUp() public {
        account = new MockLeakedAccount();
        (key, keyPk) = makeAddrAndKey("guardian");
        g = new GuardianSigner(Devnet.ERC8421_WORKSHOP, address(account), key, MAX_FEE, TxParam.MAX_COST);
        simAttach(address(g));
        account.setRoles(makeAddr("vault"), address(0), address(g));
        vm.deal(address(g), 1 ether);
    }

    function _tx(address target, bytes memory data, uint256 signPk, address signerAddr) internal {
        simBegin(address(g));
        simSetFees(1 gwei, 2 gwei, 0.001 ether);
        simVerify(SELF_VERIFY, address(0), 60_000, abi.encodeCall(GuardianSigner.verifyFrame, ()));
        simSender(target, 100_000, 0, data);
        simAddSecp256k1(signerAddr);
        simSignSecp256k1(0, signPk);
    }

    function test_freeze() public {
        _tx(address(account), abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()), keyPk, key);
        SimResult memory r = simRunValid();
        assertEq(r.frames[0].foreignSloads, 0);
        assertFalse(r.frames[0].staticViolation);
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertTrue(account.hotFrozen());
    }

    function test_wrongKey_rejected() public {
        (address m, uint256 mPk) = makeAddrAndKey("mallory");
        _tx(address(account), abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()), mPk, m);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadSignature.selector);
    }

    function test_onlyFreeze_otherSelectorRejected() public {
        _tx(address(account), abi.encodeCall(ILeakedAccountRoles.vaultFreeze, ()), keyPk, key);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadFrameShape.selector);
    }

    function test_onlyAccount_otherTargetRejected() public {
        _tx(makeAddr("other"), abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()), keyPk, key);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadFrameShape.selector);
    }

    function test_extraCalldataRejected() public {
        _tx(address(account), abi.encodePacked(ILeakedAccountRoles.guardianFreeze.selector, uint256(1)), keyPk, key);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadFrameShape.selector);
    }

    function test_feeBound() public {
        _tx(address(account), abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()), keyPk, key);
        simSetFees(1 gwei, 2 gwei, MAX_FEE + 1);
        simSignSecp256k1(0, keyPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.FeeTooHigh.selector);
    }

    function test_arbitraryEntry_rejectedWithoutHalting() public {
        simBegin(address(g));
        simSetFees(1 gwei, 2 gwei, 0.001 ether);
        simVerify(SELF_VERIFY, address(0), 60_000, abi.encodeCall(GuardianSigner.verifyFrame, ()));
        simSender(address(account), 100_000, 0, abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()));
        simAddArbitrary(hex"01");
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadSignature.selector);
    }

    function test_twoSignatures_rejected() public {
        _tx(address(account), abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()), keyPk, key);
        simAddSecp256k1(key);
        simSignSecp256k1(0, keyPk);
        simSignSecp256k1(1, keyPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(uint8(r.reason), uint8(InvalidReason.VERIFY_FAILED));
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadSignature.selector);
    }

    function test_extraSenderFrame_rejected() public {
        _tx(address(account), abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()), keyPk, key);
        simSender(address(account), 100_000, 0, abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()));
        simSignSecp256k1(0, keyPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadFrameShape.selector);
        assertFalse(account.hotFrozen());
    }

    function test_onlyVerifyScope_rejected() public {
        simBegin(address(g));
        simSetFees(1 gwei, 2 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 60_000, abi.encodeCall(GuardianSigner.verifyFrame, ()));
        simSender(address(account), 100_000, 0, abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()));
        simAddSecp256k1(key);
        simSignSecp256k1(0, keyPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.ScopeNotSelfVerify.selector);
    }

    function test_senderWithValue_rejected() public {
        simBegin(address(g));
        simSetFees(1 gwei, 2 gwei, 0.001 ether);
        simVerify(SELF_VERIFY, address(0), 60_000, abi.encodeCall(GuardianSigner.verifyFrame, ()));
        simSender(address(account), 100_000, 1, abi.encodeCall(ILeakedAccountRoles.guardianFreeze, ()));
        simAddSecp256k1(key);
        simSignSecp256k1(0, keyPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), GuardianSigner.BadFrameShape.selector);
    }
}

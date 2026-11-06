// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountImpl} from "../../src/account/QueueBitAccountImpl.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {PQRoleSigner} from "../../src/roles/PQRoleSigner.sol";
import {C13Kat} from "../pq/C13Kat.sol";
import {AccountTestBase} from "./AccountTestBase.sol";

/// Bound role signers end to end (no M1 "vault stand-in"): the account derives its VaultSigner from the vault's C13
/// public key at initialize; the clone is deployed afterwards by anyone; a real C13 signature (KAT set C) then
/// drives the account through the clone's Path B under FrameSim. No cycle: the account address commits to the pk
/// (init data), the clone's to the account.
contract BoundRoleSignersTest is AccountTestBase {
    C13Verifier internal c13;
    C13Kat.Vector internal kat;
    QueueBitAccountImpl internal acct;
    QueueBitAccountRoles internal acctRoles;
    address internal derived;
    address internal payer;
    uint256 internal payerPk;
    address internal recipient = makeAddr("recipient");
    bytes32 internal constant SALT = keccak256("bound-test");

    function setUp() public override {
        super.setUp();
        kat = C13Kat.load(1);
        c13 = new C13Verifier();
        (payer, payerPk) = makeAddrAndKey("vaultDevicePayer");
        simAttach(address(signerFactory.implementation()));

        IQueueBitAccount.InitConfig memory c = _defaultCfg();
        c.vault = IQueueBitAccount.RoleSignerParams(SALT, kat.pk, address(c13), payer);
        delete c.recovery;
        bytes memory init = _initData(c);
        address predicted = factory.predictAccount(SALT, address(impl), init);
        acct = QueueBitAccountImpl(payable(factory.createAccount(SALT, address(impl), init)));
        assertEq(address(acct), predicted);
        acctRoles = QueueBitAccountRoles(payable(address(acct)));
        (derived,,,,) = acctRoles.getRoles();
        vm.deal(address(acct), 1 ether);
    }

    function _deploySigner(address by) internal returns (PQRoleSigner s) {
        vm.prank(by);
        s = PQRoleSigner(
            payable(signerFactory.createRoleSigner{value: 0}(SALT, 1, address(acct), kat.pk, address(c13), payer))
        );
        vm.deal(address(s), 1 ether);
    }

    function _pathB(address signer, bytes memory body, bytes memory witness) internal {
        simBegin(signer);
        simSetFees(1 gwei, 2 gwei, 0.01 ether);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), 90_000, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), 500_000, 0, body);
        simAddArbitrary(witness);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
    }

    function _vaultSpend(uint256 weiAmount) internal view returns (bytes memory) {
        IQueueBitAccount.Call[] memory calls = new IQueueBitAccount.Call[](1);
        calls[0] = IQueueBitAccount.Call(recipient, weiAmount, "");
        return abi.encodeCall(
            PQRoleSigner.executePQ, (0, address(acct), abi.encodeCall(QueueBitAccountRoles.vaultExecute, (calls, 0)))
        );
    }

    function test_derivedAtInitialize_counterfactual_lazyDeployByAnyone() public {
        assertEq(derived, signerFactory.predictRoleSigner(SALT, 1, address(acct), kat.pk, address(c13), payer));
        assertEq(derived.code.length, 0, "not deployed by initialize");
        PQRoleSigner s = _deploySigner(stranger); // anyone, any time
        assertEq(address(s), derived);
        assertEq(s.account(), address(acct), "bound to this account");
        assertEq(s.pk(), kat.pk);
        assertEq(s.role(), 1);
        assertEq(s.payerKey(), payer);
        // idempotent: a second (front-running or late) deployment returns the same signer
        assertEq(_deploySigner(alice).account(), address(acct));
    }

    function test_boundVault_pathB_c13_drivesAccount() public {
        PQRoleSigner s = _deploySigner(stranger);
        _pathB(address(s), _vaultSpend(0.01 ether), kat.sig);
        SimResult memory r = simRunValid();
        assertEq(r.payer, address(s), "the signer pays for itself");
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(recipient.balance, 0.01 ether, "vault spend executed through the bound signer");
        (uint256 avail,,) = acctRoles.getVaultBucket();
        assertEq(avail, THRESHOLD - 30 * USD);
    }

    function test_boundVault_forgedWitness_movesNothing() public {
        PQRoleSigner s = _deploySigner(stranger);
        bytes memory forged = bytes.concat(kat.sig);
        forged[100] ^= 0x01;
        _pathB(address(s), _vaultSpend(0.01 ether), forged);
        SimResult memory r = simRun();
        assertTrue(r.valid);
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(recipient.balance, 0);
    }

    /// The clone with the same pk bound to another account cannot act on this one (and is not its vault).
    function test_signerBoundElsewhere_refused() public {
        address other = makeAddr("otherAccount");
        PQRoleSigner s =
            PQRoleSigner(payable(signerFactory.createRoleSigner(SALT, 1, other, kat.pk, address(c13), payer)));
        vm.deal(address(s), 1 ether);
        assertTrue(address(s) != derived);
        _pathB(address(s), _vaultSpend(0.01 ether), kat.sig);
        SimResult memory r = simRun();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.TargetNotAllowed.selector);
        assertEq(recipient.balance, 0);
    }

    /// Open-mode hot payment to an arbitrary recipient on the bound account, then the bound vault tightens to
    /// Strict through its signer (instant) and the same payment is refused.
    function test_boundVault_tightensRecipientMode() public {
        vm.deal(tank, 1 ether);
        vm.prank(address(acct));
        acct.hotExecute(3 * USD, _one(_ethSend(recipient, 0.001 ether)));
        assertEq(recipient.balance, 0.001 ether);

        PQRoleSigner s = _deploySigner(stranger);
        bytes memory body = abi.encodeCall(
            PQRoleSigner.executePQ,
            (
                0,
                address(acct),
                abi.encodeCall(QueueBitAccountRoles.vaultSetRecipientMode, (IQueueBitAccount.RecipientMode.Strict))
            )
        );
        _pathB(address(s), body, kat.sig);
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(uint256(acct.recipientMode()), uint256(IQueueBitAccount.RecipientMode.Strict));
        vm.prank(address(acct));
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, recipient, bytes4(0)));
        acct.hotExecute(3 * USD, _one(_ethSend(recipient, 0.001 ether)));
    }

    /// The derived address commits to every clone parameter (salt, role, account, pk, verifier, payerKey): a clone
    /// with any one of them changed lands elsewhere (with code), the derived address stays empty until the exact
    /// parameters are used, so nothing but the vault's own configuration can ever get code where the account looks.
    function test_derivedAddress_commitsToEveryCloneParam() public {
        C13Verifier c13b = new C13Verifier();
        address a = address(acct);
        address[6] memory other = [
            signerFactory.createRoleSigner(keccak256("other-salt"), 1, a, kat.pk, address(c13), payer),
            signerFactory.createRoleSigner(SALT, 2, a, kat.pk, address(c13), payer),
            signerFactory.createRoleSigner(SALT, 1, makeAddr("otherAccount"), kat.pk, address(c13), payer),
            signerFactory.createRoleSigner(SALT, 1, a, bytes32(uint256(kat.pk) ^ 1), address(c13), payer),
            signerFactory.createRoleSigner(SALT, 1, a, kat.pk, address(c13b), payer),
            signerFactory.createRoleSigner(SALT, 1, a, kat.pk, address(c13), alice)
        ];
        for (uint256 i; i < 6; ++i) {
            assertTrue(other[i] != derived, "a changed parameter landed on the derived address");
            assertGt(other[i].code.length, 0);
            for (uint256 j; j < i; ++j) {
                assertTrue(other[i] != other[j]);
            }
        }
        assertEq(derived.code.length, 0, "only the exact parameters deploy the derived signer");
        assertEq(address(_deploySigner(stranger)), derived);
    }
}

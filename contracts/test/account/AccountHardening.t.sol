// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountImpl} from "../../src/account/QueueBitAccountImpl.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {AccountTestBase} from "./AccountTestBase.sol";

/// Delta-review hardening (2026-11-06, after 9b918a3):
/// 1. role independence: the recovery's PQ key differs from the vault's (`SameRoleKey`), and the vault / recovery
///    signer addresses differ from each other, the account, the hot key and the tank (`BadAddress`), at initialize
///    and on every later install (recovery install, vault rotation, hot-key rotation, tank change);
/// 2. self-defeating hot recipients: never the account, a role signer or (a `transfer`) the token itself, in either
///    mode; in Open mode, a recipient that is not allowlisted is also never the tank, a guardian or an allowlisted
///    token (`ForbiddenRecipient`). The tank's top-up path (its allowlist entry from initialize) keeps working.
/// Runs in Open (this contract) and Strict (`AccountHardeningStrictTest`).
contract AccountHardeningTest is AccountTestBase {
    bytes32 internal constant PK_A = keccak256("hardening.pk-a");
    bytes32 internal constant PK_B = keccak256("hardening.pk-b");
    uint256 internal saltN = 100;

    /// A deployed PQRoleSigner clone (unbound: account = 0) reporting `pk`.
    function _clone(uint8 role, bytes32 pk) internal returns (address) {
        return signerFactory.createRoleSigner(bytes32(saltN++), role, address(0), pk, address(pqVerifier), address(0));
    }

    function _create(IQueueBitAccount.InitConfig memory c) internal returns (QueueBitAccountRoles) {
        return QueueBitAccountRoles(payable(factory.createAccount(bytes32(saltN++), address(impl), _initData(c))));
    }

    function _createReverts(IQueueBitAccount.InitConfig memory c, bytes memory err) internal {
        bytes memory init = _initData(c);
        bytes32 salt = bytes32(saltN++);
        vm.expectRevert(err);
        factory.createAccount(salt, address(impl), init);
    }

    function _badAddress(address a) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IQueueBitAccount.BadAddress.selector, a);
    }

    function _forbidden(address a) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IQueueBitAccount.ForbiddenRecipient.selector, a);
    }

    /// The revert for a recipient refused only in Open mode (Strict refuses it as not allowlisted).
    function _openOnly(address to, bytes4 sel) internal view virtual returns (bytes memory) {
        sel;
        return _forbidden(to);
    }

    function _hotReverts(IQueueBitAccount.Call memory c, bytes memory err) internal {
        uint256 avail = _bucketAvailable();
        vm.prank(address(account));
        vm.expectRevert(err);
        account.hotExecute(PER_TX, _one(c));
        assertEq(_bucketAvailable(), avail, "nothing debited");
    }

    function _wethTransfer(address to, uint256 amount) internal view returns (IQueueBitAccount.Call memory) {
        return IQueueBitAccount.Call(address(weth), 0, abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
    }

    // ------------------------------------------------------------------------ 1. role independence ------

    /// PoC: the same PQ key under both roles derives two DIFFERENT signer addresses (the role is in the clone's
    /// args), so the address-only check let it through; a recovery that is the vault's own key is no recovery.
    function test_init_bound_samePk_SameRoleKey() public {
        IQueueBitAccount.InitConfig memory c = _defaultCfg();
        c.recovery.pk = VAULT_PK;
        address predicted = factory.predictAccount(bytes32(saltN), address(impl), _initData(c));
        assertTrue(
            _derivedSigner(predicted, 1, VAULT_PK, vaultPayer) != _derivedSigner(predicted, 2, VAULT_PK, address(0)),
            "distinct addresses: the address check alone does not catch it"
        );
        _createReverts(c, abi.encodeWithSelector(IQueueBitAccount.SameRoleKey.selector));
        // different salt / payer / verifier change nothing: the key is the same
        c.recovery.salt = keccak256("other");
        c.recovery.payerKey = stranger;
        _createReverts(c, abi.encodeWithSelector(IQueueBitAccount.SameRoleKey.selector));
        // distinct keys: fine (the default setUp account)
        c.recovery.pk = RECOVERY_PK;
        _create(c);
    }

    /// Explicit signers report their key through `pk()`; mixed bound / explicit too.
    function test_init_explicitAndMixed_samePk_SameRoleKey() public {
        address vA = _clone(1, PK_A);
        address rA = _clone(2, PK_A);
        address rB = _clone(2, PK_B);
        _createReverts(_explicitCfg(vA, rA), abi.encodeWithSelector(IQueueBitAccount.SameRoleKey.selector));
        _create(_explicitCfg(vA, rB));
        // bound vault (pk given), explicit recovery holding the same key
        IQueueBitAccount.InitConfig memory c = _defaultCfg();
        delete c.recovery;
        c.vault.pk = PK_A;
        c.recoverySigner = rA;
        _createReverts(c, abi.encodeWithSelector(IQueueBitAccount.SameRoleKey.selector));
        c.recoverySigner = rB;
        _create(c);
        // a code-less explicit signer reports no key: address checks only
        _create(_explicitCfg(makeAddr("eoaVault"), makeAddr("eoaRecovery")));
    }

    function test_init_signersDistinctFromHotKeyAndTank() public {
        _createReverts(_explicitCfg(hot, recovery), _badAddress(hot));
        _createReverts(_explicitCfg(vault, hot), _badAddress(hot));
        _createReverts(_explicitCfg(vault, vault), _badAddress(vault));
        IQueueBitAccount.InitConfig memory c = _explicitCfg(vault, recovery);
        c.tank = vault;
        _createReverts(c, _badAddress(vault));
        c.tank = recovery;
        _createReverts(c, _badAddress(recovery));
    }

    /// First recovery install (instant) checks the deployed vault's key and the hot key / tank.
    function test_recoveryInstall_independent() public {
        address v = _clone(1, PK_A);
        QueueBitAccountRoles a = _create(_explicitCfg(v, address(0)));
        vm.startPrank(v);
        address same = _clone(2, PK_A);
        vm.expectRevert(IQueueBitAccount.SameRoleKey.selector);
        a.vaultSetRecoverySigner(same);
        vm.expectRevert(_badAddress(hot));
        a.vaultSetRecoverySigner(hot);
        vm.expectRevert(_badAddress(tank));
        a.vaultSetRecoverySigner(tank);
        vm.expectRevert(_badAddress(v));
        a.vaultSetRecoverySigner(v);
        address other = _clone(2, PK_B);
        a.vaultSetRecoverySigner(other);
        vm.stopPrank();
        (, address r,,,) = a.getRoles();
        assertEq(r, other);
    }

    /// A queued recovery change is held to the same rule (the queued op's inner call reverts).
    function test_recoveryChange_queued_independent() public {
        address v = _clone(1, PK_A);
        address r = _clone(2, PK_B);
        QueueBitAccountRoles a = _create(_explicitCfg(v, r));
        address same = _clone(2, PK_A);
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](1);
        c[0] = IQueueBitAccount.Call(address(a), 0, abi.encodeCall(QueueBitAccountRoles.vaultSetRecoverySigner, (same)));
        vm.prank(v);
        bytes32 opId = a.vaultQueue(c, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        a.executeQueued(opId, c);
        (, address cur,,,) = a.getRoles();
        assertEq(cur, r, "unchanged");
    }

    /// A vault rotation may not install the recovery's own key (or the hot key / tank) as the new vault.
    function test_vaultRotation_independent() public {
        address v = _clone(1, PK_A);
        address r = _clone(2, PK_B);
        QueueBitAccountRoles a = _create(_explicitCfg(v, r));
        vm.startPrank(r);
        address recoveryKeyAsVault = _clone(1, PK_B);
        vm.expectRevert(IQueueBitAccount.SameRoleKey.selector);
        a.recoveryStartVaultRotation(recoveryKeyAsVault);
        vm.expectRevert(_badAddress(hot));
        a.recoveryStartVaultRotation(hot);
        vm.expectRevert(_badAddress(tank));
        a.recoveryStartVaultRotation(tank);
        a.recoveryStartVaultRotation(_clone(1, keccak256("fresh vault key")));
        vm.stopPrank();
    }

    function test_hotKeyAndTank_neverARoleSigner() public {
        vm.startPrank(vault);
        vm.expectRevert(_badAddress(vault));
        roles.vaultSetHotKey(vault);
        vm.expectRevert(_badAddress(recovery));
        roles.vaultSetHotKey(recovery);
        vm.expectRevert(_badAddress(vault));
        roles.vaultSetFeePolicy(MAX_PRIO, false, vault);
        vm.expectRevert(_badAddress(recovery));
        roles.vaultSetFeePolicy(MAX_PRIO, false, recovery);
        roles.vaultSetFeePolicy(MAX_PRIO, false, address(0)); // unpinning stays allowed
        vm.stopPrank();
        // a pending rotation's signer is reserved too
        address newVault = makeAddr("newVault");
        vm.prank(recovery);
        roles.recoveryStartVaultRotation(newVault);
        vm.startPrank(vault);
        vm.expectRevert(_badAddress(newVault));
        roles.vaultSetHotKey(newVault);
        vm.expectRevert(_badAddress(newVault));
        roles.vaultSetFeePolicy(MAX_PRIO, false, newVault);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- 2. self-defeating recipients ------

    /// PoC: in Open mode a `transfer` to the token contract itself was admitted (any non-zero `to`): the tokens
    /// are stuck in the token contract and the bucket is debited. Both modes refuse it now.
    function test_tokenToItself_forbidden() public {
        uint256 bal = usdc.balanceOf(address(account));
        _hotReverts(_usdcTransfer(address(usdc), 1 * USD), _forbidden(address(usdc)));
        assertEq(usdc.balanceOf(address(account)), bal);
        assertEq(usdc.balanceOf(address(usdc)), 0);
    }

    /// Paying the account itself by `transfer` moves nothing yet debits the bucket; ETH to the account was already
    /// a refused self-call.
    function test_account_forbidden() public {
        _hotReverts(_usdcTransfer(address(account), 1 * USD), _forbidden(address(account)));
        _hotReverts(
            _ethSend(address(account), 1 ether),
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(account), bytes4(0))
        );
    }

    /// Role signers are never paid by the hot key (they hold no spendable account balance: funding one is the
    /// vault's own decision), in both modes.
    function test_roleSigners_forbidden() public {
        _hotReverts(_usdcTransfer(vault, 1 * USD), _forbidden(vault));
        _hotReverts(_ethSend(vault, 0.001 ether), _forbidden(vault));
        _hotReverts(_usdcTransfer(recovery, 1 * USD), _forbidden(recovery));
        _hotReverts(_ethSend(recovery, 0.001 ether), _forbidden(recovery));
    }

    /// PoC (both modes, ahead of the allowlist): a recipient allowlisted before a role change (here `alice`, made
    /// the vault by a recovery rotation) is no longer payable once it is a role signer.
    function test_staleTarget_becomesVault_forbidden() public {
        _hot(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        vm.prank(recovery);
        roles.recoveryStartVaultRotation(alice);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        roles.recoveryFinalizeVaultRotation();
        assertTrue(account.isTarget(alice), "still allowlisted");
        _hotReverts(_usdcTransfer(alice, 1 * USD), _forbidden(alice));
        _hotReverts(_ethSend(alice, 0.001 ether), _forbidden(alice));
    }

    function test_guardian_openOnly() public {
        _hotReverts(_usdcTransfer(guardian, 1 * USD), _openOnly(guardian, IERC20.transfer.selector));
        _hotReverts(_ethSend(guardian, 0.001 ether), _openOnly(guardian, bytes4(0)));
        // the vault allowlisting a guardian (a friend who is also a payee) is an explicit decision: both modes
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (guardian, true)));
        _hot(1 * USD, _one(_usdcTransfer(guardian, 1 * USD)));
        assertEq(usdc.balanceOf(guardian), 1 * USD);
    }

    /// ETH or another token sent to an allowlisted token's contract (Open, not allowlisted).
    function test_allowlistedTokenContract_openOnly() public {
        _hotReverts(_ethSend(address(usdc), 0.001 ether), _openOnly(address(usdc), bytes4(0)));
        _hotReverts(_wethTransfer(address(usdc), 0.001 ether), _openOnly(address(usdc), IERC20.transfer.selector));
        _hotReverts(_wethTransfer(address(weth), 0.001 ether), _forbidden(address(weth)));
    }

    /// The tank's top-up path (allowlisted at initialize) keeps working in both modes.
    function test_tankTopUp_keepsWorking() public {
        assertTrue(account.isTarget(tank));
        uint256 t0 = tank.balance;
        _hot(PER_TX, _one(_ethSend(tank, 0.01 ether)));
        assertEq(tank.balance, t0 + 0.01 ether);
        _hot(1 * USD, _one(_usdcTransfer(tank, 1 * USD)));
        assertEq(usdc.balanceOf(tank), 1 * USD);
    }

    /// A re-pinned tank the vault did not allowlist is not an everyday (Open) recipient; allowlisting it restores
    /// the top-up path. (The old tank's allowlist entry is unaffected.)
    function test_repinnedTank_openOnly_untilAllowlisted() public {
        address newTank = makeAddr("newTank");
        vm.prank(vault);
        roles.vaultSetFeePolicy(MAX_PRIO, false, newTank);
        _hotReverts(_ethSend(newTank, 0.001 ether), _openOnly(newTank, bytes4(0)));
        _hotReverts(_usdcTransfer(newTank, 1 * USD), _openOnly(newTank, IERC20.transfer.selector));
        _hot(PER_TX, _one(_ethSend(tank, 0.001 ether))); // old tank: still allowlisted
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (newTank, true)));
        _hot(PER_TX, _one(_ethSend(newTank, 0.001 ether)));
        assertEq(newTank.balance, 0.001 ether);
    }

    function test_burn_stillNotAllowed() public {
        _hotReverts(
            _usdcTransfer(address(0), 1 * USD),
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(0), IERC20.transfer.selector)
        );
        _hotReverts(
            _ethSend(address(0), 0.001 ether),
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(0), bytes4(0))
        );
    }

    /// One forbidden leg reverts the whole batch: an allowed payment before it is undone.
    function test_forbiddenLeg_revertsBatch() public {
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](2);
        c[0] = _usdcTransfer(alice, 1 * USD);
        c[1] = _usdcTransfer(address(usdc), 1 * USD);
        vm.prank(address(account));
        vm.expectRevert(_forbidden(address(usdc)));
        account.hotExecute(PER_TX, c);
        assertEq(usdc.balanceOf(alice), 0);
    }
}

/// The same, with the recipient allowlist (`RecipientMode.Strict`): the Open-only refusals become `NotAllowed`.
contract AccountHardeningStrictTest is AccountHardeningTest {
    function setUp() public override {
        super.setUp();
        _strict();
        assertEq(uint256(account.recipientMode()), uint256(IQueueBitAccount.RecipientMode.Strict));
    }

    function _openOnly(address to, bytes4 sel) internal pure override returns (bytes memory) {
        return abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, to, sel);
    }
}

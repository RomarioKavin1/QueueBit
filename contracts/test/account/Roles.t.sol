// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {ILeakedAccount} from "../../src/account/ILeakedAccount.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {LeakedAccountRoles} from "../../src/account/LeakedAccountRoles.sol";
import {AccountTestBase} from "./AccountTestBase.sol";
import {MockToken, LeakedAccountImplV2, NotUUPS} from "./mocks/AccountMocks.sol";

/// Vault / recovery / guardian surface, timelock, bunker, upgrade, migration (§10.3.2, M3).
contract RolesTest is AccountTestBase {
    address internal newVault = makeAddr("newVault");

    function _spend(address to, uint256 usdcAmount) internal view returns (ILeakedAccount.Call[] memory) {
        return _one(_usdcTransfer(to, usdcAmount));
    }

    function _now() internal view returns (uint48) {
        return uint48(vm.getBlockTimestamp());
    }

    // ------------------------------------------------------------------------------------- initialize ------

    function test_initialize_state() public view {
        ILeakedAccount.HotConfig memory c = account.getHotConfig();
        assertEq(c.hotKey, hot);
        assertEq(c.tank, tank);
        assertEq(c.perTxMaxUsd, PER_TX);
        assertEq(c.maxFeeWeiPerTx, MAX_FEE_WEI);
        assertEq(c.maxPriorityFeePerGas, MAX_PRIO);
        assertEq(c.maxHotFrames, 4);
        assertFalse(c.selfPay || c.hotFrozen || c.bunker);
        (address v, address r,,,) = roles.getRoles();
        assertEq(v, vault);
        assertEq(r, recovery);
        assertTrue(account.isTarget(tank));
        assertTrue(roles.isValueVerifier(0x000000000022D473030F116dDEE9F6B43aC78BA3));
        assertEq(account.accountId(), "leaked.account.1.0.0");
        (, uint256 cap, uint48 delay) = roles.getVaultBucket();
        assertEq(cap, THRESHOLD);
        assertEq(delay, DELAY);
    }

    function test_initialize_onlyOnce_andImplLocked() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        account.initialize(_defaultCfg());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(_defaultCfg());
    }

    function test_initialize_defaultsAndValidation() public {
        ILeakedAccount.InitConfig memory c = _defaultCfg();
        c.maxHotFrames = 0;
        c.timelockDelay = 0;
        c.recoverySigner = address(0);
        c.tank = address(0);
        c.ethUsdPrice = 0;
        LeakedAccountImpl a =
            LeakedAccountImpl(payable(factory.createAccount(bytes32(uint256(2)), address(impl), _initData(c))));
        assertEq(a.getHotConfig().maxHotFrames, 4);
        (,, uint48 delay) = LeakedAccountRoles(payable(address(a))).getVaultBucket();
        assertEq(delay, 48 hours);
        assertFalse(a.getToken(address(0)).allowed);

        c = _defaultCfg();
        c.hotKey = address(0);
        vm.expectRevert();
        factory.createAccount(bytes32(uint256(3)), address(impl), _initData(c));
        // explicit mode: the old address checks
        c = _explicitCfg(address(0), recovery);
        vm.expectRevert();
        factory.createAccount(bytes32(uint256(3)), address(impl), _initData(c));
        c = _explicitCfg(vault, vault);
        vm.expectRevert();
        factory.createAccount(bytes32(uint256(3)), address(impl), _initData(c));
        c = _explicitCfg(vault, recovery);
        c.tank = vault;
        vm.expectRevert();
        factory.createAccount(bytes32(uint256(3)), address(impl), _initData(c));
        c = _defaultCfg();
        c.maxHotFrames = 1;
        vm.expectRevert();
        factory.createAccount(bytes32(uint256(3)), address(impl), _initData(c));
        c = _defaultCfg();
        c.timelockDelay = 1;
        vm.expectRevert();
        factory.createAccount(bytes32(uint256(3)), address(impl), _initData(c));
    }

    // ------------------------------------------------------------------------ bound role signers (init) ------

    /// Bound mode: the account stores the signers `predictRoleSigner(salt, role, address(this), ...)` gives, and
    /// logs the arguments that deploy them; the account address commits to the PQ parameters (init data).
    function test_initialize_boundSignersDerived() public {
        ILeakedAccount.InitConfig memory c = _defaultCfg();
        c.vault.salt = bytes32(uint256(5));
        bytes memory init = _initData(c);
        address predicted = factory.predictAccount(bytes32(uint256(4)), address(impl), init);
        address v = signerFactory.predictRoleSigner(
            bytes32(uint256(5)), 1, predicted, VAULT_PK, address(pqVerifier), vaultPayer
        );
        address r = _derivedSigner(predicted, 2, RECOVERY_PK, address(0));
        vm.expectEmit(true, true, true, true, predicted);
        emit ILeakedAccount.RoleSignerDerived(
            1, v, address(signerFactory), bytes32(uint256(5)), VAULT_PK, address(pqVerifier), vaultPayer
        );
        vm.expectEmit(true, true, true, true, predicted);
        emit ILeakedAccount.RoleSignerDerived(
            2, r, address(signerFactory), bytes32(0), RECOVERY_PK, address(pqVerifier), address(0)
        );
        address a = factory.createAccount(bytes32(uint256(4)), address(impl), init);
        assertEq(a, predicted);
        (address gv, address gr,,,) = LeakedAccountRoles(payable(a)).getRoles();
        assertEq(gv, v);
        assertEq(gr, r);
        assertEq(v.code.length, 0, "counterfactual: nothing deployed at initialize");
        // another vault pk -> another account address (the address commits to the vault key)
        c.vault.pk = ~VAULT_PK;
        assertTrue(factory.predictAccount(bytes32(uint256(4)), address(impl), _initData(c)) != predicted);
    }

    function test_initialize_boundValidation() public {
        bytes32 salt = bytes32(uint256(6));
        ILeakedAccount.InitConfig memory c = _defaultCfg();
        c.vaultSigner = stranger; // bound and explicit at once
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        factory.createAccount(salt, address(impl), _initData(c));
        c = _defaultCfg();
        c.recoverySigner = stranger;
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        factory.createAccount(salt, address(impl), _initData(c));
        c = _defaultCfg();
        c.roleSignerFactory = address(0);
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        factory.createAccount(salt, address(impl), _initData(c));
        c = _defaultCfg();
        c.roleSignerFactory = stranger; // no code
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        factory.createAccount(salt, address(impl), _initData(c));
        c = _defaultCfg();
        c.vault.verifier = stranger; // no code: no sigLength, createRoleSigner would refuse forever
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        factory.createAccount(salt, address(impl), _initData(c));
        c = _defaultCfg();
        c.vault.verifier = address(usdc); // answers nothing useful
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        factory.createAccount(salt, address(impl), _initData(c));
        c = _defaultCfg();
        c.vault.pk = 0; // falls back to explicit mode, but stray parameters are refused
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        factory.createAccount(salt, address(impl), _initData(c));
        c.vault.verifier = address(0);
        c.vault.payerKey = address(0);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(0)));
        factory.createAccount(salt, address(impl), _initData(c)); // and then needs an explicit vault
        // recovery optional in bound mode
        c = _defaultCfg();
        delete c.recovery;
        LeakedAccountRoles a = LeakedAccountRoles(payable(factory.createAccount(salt, address(impl), _initData(c))));
        (, address r,,,) = a.getRoles();
        assertEq(r, address(0));
    }

    /// Unbound / explicit mode stays supported (backward compatibility: an unbound `PQRoleSigner`, a test key).
    function test_initialize_explicitModeStillSupported() public {
        address v = makeAddr("unboundVault");
        LeakedAccountRoles a = LeakedAccountRoles(
            payable(factory.createAccount(bytes32(uint256(7)), address(impl), _initData(_explicitCfg(v, recovery))))
        );
        (address gv, address gr,,,) = a.getRoles();
        assertEq(gv, v);
        assertEq(gr, recovery);
        vm.prank(v);
        a.vaultFreeze();
    }

    // ------------------------------------------------------------------------------ recipient mode ------

    function test_recipientMode_tightenInstant_loosenQueued() public {
        assertEq(uint256(account.recipientMode()), uint256(ILeakedAccount.RecipientMode.Open));
        vm.prank(vault);
        vm.expectEmit(address(account));
        emit ILeakedAccount.RecipientModeSet(ILeakedAccount.RecipientMode.Strict);
        roles.vaultSetRecipientMode(ILeakedAccount.RecipientMode.Strict);
        assertEq(uint256(account.recipientMode()), uint256(ILeakedAccount.RecipientMode.Strict));
        vm.prank(vault);
        roles.vaultSetRecipientMode(ILeakedAccount.RecipientMode.Strict); // idempotent, still instant
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetRecipientMode(ILeakedAccount.RecipientMode.Open);
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetRecipientMode, (ILeakedAccount.RecipientMode.Open)));
        assertEq(uint256(account.recipientMode()), uint256(ILeakedAccount.RecipientMode.Open));
        vm.prank(vault);
        roles.vaultSetRecipientMode(ILeakedAccount.RecipientMode.Open); // Open -> Open loosens nothing
    }

    /// Only the vault (or its queue): not the guardian, the recovery signer, the hot key's EOA, the hot batch.
    function test_recipientMode_onlyVault() public {
        address[4] memory who = [guardian, recovery, hot, stranger];
        for (uint256 i; i < 4; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(ILeakedAccount.Unauthorized.selector);
            roles.vaultSetRecipientMode(ILeakedAccount.RecipientMode.Strict);
        }
        ILeakedAccount.Call memory self =
            _selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetRecipientMode, (ILeakedAccount.RecipientMode.Strict)));
        vm.expectRevert(
            abi.encodeWithSelector(
                ILeakedAccount.NotAllowed.selector, address(account), LeakedAccountRoles.vaultSetRecipientMode.selector
            )
        );
        _hot(0, _one(self));
    }

    function test_recipientMode_strictAtInitialize() public {
        ILeakedAccount.InitConfig memory c = _explicitCfg(vault, recovery);
        c.recipientMode = ILeakedAccount.RecipientMode.Strict;
        LeakedAccountImpl a =
            LeakedAccountImpl(payable(factory.createAccount(bytes32(uint256(8)), address(impl), _initData(c))));
        assertEq(uint256(a.recipientMode()), uint256(ILeakedAccount.RecipientMode.Strict));
    }

    function test_unknownSelectorReverts_andModuleNotDirectlyUsable() public {
        (bool ok,) = address(account).call(abi.encodeWithSignature("nope()"));
        assertFalse(ok);
        vm.prank(vault);
        vm.expectRevert(LeakedAccountRoles.NotDelegated.selector);
        rolesModule.vaultFreeze();
    }

    function test_implConstructorNeedsModuleCode() public {
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(0)));
        new LeakedAccountImpl(Devnet.ERC8421_WORKSHOP, true, address(0));
    }

    // ------------------------------------------------------------------------------------ vaultExecute ------

    function test_vaultExecute_withinDailyThreshold() public {
        vm.expectEmit(address(account));
        emit ILeakedAccount.VaultExecuted(1_500 * USD, THRESHOLD - 1_500 * USD, 1);
        vm.prank(vault);
        roles.vaultExecute(_spend(stranger, 1_500 * USD), 0); // measured outflow wins over the declared 0
        assertEq(usdc.balanceOf(stranger), 1_500 * USD);
    }

    function test_vaultExecute_overThresholdMustQueue() public {
        vm.prank(vault);
        roles.vaultExecute(_spend(stranger, 1_500 * USD), 0);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.VaultOverDailyThreshold.selector, 600 * USD, 500 * USD));
        roles.vaultExecute(_spend(stranger, 600 * USD), 0);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(ILeakedAccount.VaultOverDailyThreshold.selector, THRESHOLD + 1, 500 * USD)
        );
        roles.vaultExecute(_spend(stranger, 1), THRESHOLD + 1); // declared wins when larger
    }

    function test_vaultExecute_reverts() public {
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultExecute(_spend(stranger, 1), 0);
        vm.prank(hot);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultExecute(_spend(stranger, 1), 0);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILeakedAccount.NotAllowed.selector, address(account), LeakedAccountRoles.vaultFreeze.selector
            )
        );
        roles.vaultExecute(_one(_selfCall(abi.encodeCall(LeakedAccountRoles.vaultFreeze, ()))), 0);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadCallCount.selector, 0));
        roles.vaultExecute(new ILeakedAccount.Call[](0), 0);
    }

    function test_vaultExecute_unpricedEthMustQueue() public {
        vm.prank(vault);
        roles.vaultSetToken(address(0), false, 0, 0);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultExecute(_one(_ethSend(stranger, 1 ether)), 0);
    }

    // -------------------------------------------------------------------------------------- the queue ------

    function test_queue_lifecycle() public {
        ILeakedAccount.Call[] memory c = _spend(stranger, 5_000 * USD);
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(c, 0);
        ILeakedAccount.QueuedOp memory q = roles.getQueued(op);
        assertEq(q.eta, _now() + DELAY);
        assertTrue(roles.isQueued(op));
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.OpNotReady.selector, op, q.eta));
        roles.executeQueued(op, c);
        vm.warp(q.eta);
        vm.expectRevert(ILeakedAccount.PayloadMismatch.selector);
        roles.executeQueued(op, _spend(stranger, 5_001 * USD));
        vm.prank(stranger); // permissionless
        roles.executeQueued(op, c);
        assertEq(usdc.balanceOf(stranger), 5_000 * USD);
        assertFalse(roles.isQueued(op));
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, op));
        roles.executeQueued(op, c); // once only (I-5)
    }

    function test_queue_cancelledNeverExecutes() public {
        ILeakedAccount.Call[] memory c = _spend(stranger, 1);
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(c, 0);
        vm.expectEmit(address(account));
        emit ILeakedAccount.QueueCancelled(op, vault);
        vm.prank(vault);
        roles.vaultCancel(op);
        vm.warp(_now() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, op));
        roles.executeQueued(op, c);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, op));
        roles.vaultCancel(op);
    }

    function test_queue_etaFixedAtQueueTime() public {
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(_spend(stranger, 1), 0);
        vm.prank(vault);
        roles.vaultSetTimelock(10 days, THRESHOLD); // longer delay is instant; existing eta unchanged
        assertEq(roles.getQueued(op).eta, _now() + DELAY);
    }

    function test_queue_reverts() public {
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultQueue(_spend(stranger, 1), 0);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadKind.selector, 2));
        roles.vaultQueue(_spend(stranger, 1), 2);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadCallCount.selector, 0));
        roles.vaultQueue(new ILeakedAccount.Call[](0), 0);
        // the hot path, the queue itself and upgrades are not queueable self-calls
        bytes memory h = abi.encodeCall(LeakedAccountImpl.hotExecute, (0, new ILeakedAccount.Call[](0)));
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILeakedAccount.NotAllowed.selector, address(account), LeakedAccountImpl.hotExecute.selector
            )
        );
        roles.vaultQueue(_one(_selfCall(h)), 1);
        vm.prank(vault);
        vm.expectRevert();
        roles.vaultQueue(_one(_selfCall(abi.encodeCall(account.upgradeToAndCall, (address(impl), "")))), 1);
        bytes32 nope = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, nope));
        roles.executeQueued(nope, new ILeakedAccount.Call[](0));
    }

    function test_executeQueued_rejectsUpgradeKind() public {
        LeakedAccountImplV2 v2 = new LeakedAccountImplV2(Devnet.ERC8421_WORKSHOP, true, address(rolesModule));
        vm.prank(vault);
        bytes32 op = roles.vaultQueueUpgrade(address(v2));
        vm.warp(_now() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadKind.selector, 2));
        roles.executeQueued(op, new ILeakedAccount.Call[](0));
    }

    // ------------------------------------------------------------------- tighten instant / loosen queued ------

    function test_cap_tightenInstant_loosenQueued() public {
        vm.prank(vault);
        roles.vaultSetCap(CAP / 2, PER_TX / 2, MAX_FEE_WEI / 2, 3);
        assertEq(account.getHotConfig().perTxMaxUsd, PER_TX / 2);
        (uint256 avail,, uint256 cap,) = account.getBucket();
        assertEq(cap, CAP / 2);
        assertEq(avail, CAP / 2, "tightening clamps available immediately");
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetCap(CAP, PER_TX / 2, MAX_FEE_WEI / 2, 3);
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetCap, (CAP * 2, PER_TX, MAX_FEE_WEI, 4)));
        (,, cap,) = account.getBucket();
        assertEq(cap, CAP * 2);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        roles.vaultSetCap(0, 0, 0, 1);
        vm.prank(stranger);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultSetCap(0, 0, 0, 2);
    }

    function test_feePolicy() public {
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetFeePolicy(MAX_PRIO, true, tank);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetFeePolicy(MAX_PRIO + 1, false, tank);
        address newTank = makeAddr("newTank");
        vm.expectEmit(address(account));
        emit ILeakedAccount.FeePolicyUpdated(MAX_PRIO / 2, false, newTank);
        vm.prank(vault);
        roles.vaultSetFeePolicy(MAX_PRIO / 2, false, newTank);
        assertEq(account.getHotConfig().tank, newTank);
        assertFalse(account.isTarget(newTank), "pin does not allowlist");
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(account)));
        roles.vaultSetFeePolicy(0, false, address(account));
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetFeePolicy, (MAX_PRIO, true, tank)));
        assertTrue(account.getHotConfig().selfPay);
        vm.prank(vault);
        roles.vaultSetFeePolicy(MAX_PRIO, false, tank); // disabling self-pay is tightening
    }

    function test_token_rules() public {
        MockToken dai = new MockToken("DAI", 18);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetToken(address(dai), true, 18, 1 * USD); // add
        vm.prank(vault);
        roles.vaultSetToken(address(usdc), true, 6, 2 * USD); // raise price: tighter
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetToken(address(usdc), true, 6, 1 * USD); // lower price
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetToken(address(usdc), true, 18, 2 * USD); // decimals
        vm.prank(vault);
        roles.vaultSetToken(address(usdc), false, 0, 0); // remove: instant
        assertFalse(account.getToken(address(usdc)).allowed);
        assertEq(roles.getTokenList().length, 1);
        vm.expectRevert(
            abi.encodeWithSelector(ILeakedAccount.NotAllowed.selector, address(usdc), IERC20.transfer.selector)
        );
        _hot(1, _one(_usdcTransfer(alice, 1)));

        _queueLoosenReverts(abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(dai), true, 18, 0)));
        _queueLoosenReverts(abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(0), true, 6, 1)));
        _queueLoosenReverts(abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(account), true, 6, 1)));
    }

    function test_token_maxList() public {
        ILeakedAccount.Call[] memory c = new ILeakedAccount.Call[](14);
        for (uint256 i; i < 14; ++i) {
            c[i] = _selfCall(
                abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(new MockToken("X", 6)), true, 6, 1))
            );
        }
        _queueAndExecute(c, 1);
        assertEq(roles.getTokenList().length, 16);
        _queueLoosenReverts(
            abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(new MockToken("Y", 6)), true, 6, 1))
        );
    }

    function test_target_rules() public {
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetTarget(stranger, true);
        vm.prank(vault);
        roles.vaultSetTarget(alice, false);
        assertFalse(account.isTarget(alice));
        address[4] memory bad = [address(0), address(account), vault, recovery];
        for (uint256 i; i < 4; ++i) {
            vm.prank(vault);
            vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, bad[i]));
            roles.vaultSetTarget(bad[i], false);
        }
    }

    function test_session_rules() public {
        uint48 exp = _now() + 10 days;
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetSession(address(router), bytes4(0x12345678), 100, exp);
        _queueLoosen(
            abi.encodeCall(LeakedAccountRoles.vaultSetSession, (address(router), bytes4(0x12345678), 100, exp))
        );
        vm.prank(vault);
        roles.vaultSetSession(address(router), bytes4(0x12345678), 50, exp - 1); // lower: instant
        assertEq(account.getSession(address(router), bytes4(0x12345678)).allowanceUsd, 50);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetSession(address(router), bytes4(0x12345678), 50, exp); // extend
        vm.expectEmit(address(account));
        emit ILeakedAccount.SessionConfigured(address(router), bytes4(0x12345678), 0, 0);
        vm.prank(vault);
        roles.vaultSetSession(address(router), bytes4(0x12345678), 0, 0); // removal
        assertEq(account.getSession(address(router), bytes4(0x12345678)).expiry, 0);
        _queueLoosenReverts(
            abi.encodeCall(LeakedAccountRoles.vaultSetSession, (address(router), bytes4(0x00000001), 1, 1))
        );
    }

    function test_valueVerifier_rules() public {
        vm.prank(vault);
        roles.vaultSetValueVerifier(stranger, true);
        assertTrue(roles.isValueVerifier(stranger));
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetValueVerifier(stranger, false);
    }

    function test_timelock_rules() public {
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetTimelock(DELAY - 1, THRESHOLD);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetTimelock(DELAY, THRESHOLD + 1);
        vm.prank(vault);
        roles.vaultSetTimelock(DELAY + 1, THRESHOLD - 1);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.BadConfig.selector);
        roles.vaultSetTimelock(31 days, 0);
    }

    function test_recoverySigner_rules() public {
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetRecoverySigner(stranger);
        // first install on an account without one is instant
        ILeakedAccount.InitConfig memory c = _explicitCfg(vault, address(0)); // same vault address, no recovery
        LeakedAccountRoles a =
            LeakedAccountRoles(payable(factory.createAccount(bytes32(uint256(9)), address(impl), _initData(c))));
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.BunkerNeedsRecovery.selector);
        a.vaultEnableBunker();
        vm.prank(vault);
        a.vaultSetRecoverySigner(recovery);
        (, address r,,,) = a.getRoles();
        assertEq(r, recovery);
        vm.prank(vault);
        a.vaultEnableBunker(); // now possible
    }

    function test_recoveryRemovalBlockedInBunker() public {
        vm.prank(vault);
        roles.vaultEnableBunker();
        _queueLoosenReverts(abi.encodeCall(LeakedAccountRoles.vaultSetRecoverySigner, (address(0))));
    }

    // ---------------------------------------------------------------------------- hot key / bunker ------

    function test_hotKeyRotation_andBunker() public {
        vm.expectEmit(address(account));
        emit ILeakedAccount.BunkerEnabled();
        vm.prank(vault);
        roles.vaultEnableBunker();
        ILeakedAccount.HotConfig memory c = account.getHotConfig();
        assertTrue(c.bunker);
        assertEq(c.hotKey, address(0), "I-7");
        address newHot = makeAddr("newHot");
        vm.prank(vault);
        roles.vaultSetHotKey(newHot);
        c = account.getHotConfig();
        assertFalse(c.bunker);
        assertEq(c.hotKey, newHot);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(0)));
        roles.vaultSetHotKey(address(0));
        vm.prank(hot);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultSetHotKey(hot);
    }

    // ------------------------------------------------------------------------------------- freeze ------

    function test_vaultFreezeUnfreezeExtend() public {
        vm.prank(vault);
        roles.vaultFreeze();
        assertEq(account.getHotConfig().frozenUntil, type(uint48).max);
        vm.prank(vault);
        roles.vaultUnfreeze();
        assertFalse(account.getHotConfig().hotFrozen);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.NotFrozen.selector);
        roles.vaultUnfreeze();
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.BadExpiry.selector);
        roles.vaultExtendFreeze(_now());
        vm.prank(vault);
        roles.vaultExtendFreeze(_now() + 5 days);
        assertEq(account.getHotConfig().frozenUntil, _now() + 5 days);
        vm.prank(stranger);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultFreeze();
    }

    function test_guardianFreeze_rateLimited() public {
        vm.expectEmit(address(account));
        emit ILeakedAccount.Frozen(guardian, _now() + 72 hours);
        vm.prank(guardian);
        roles.guardianFreeze();
        assertTrue(account.getHotConfig().hotFrozen);
        assertEq(roles.getGuardian(guardian).lastFreezeAt, _now());
        vm.warp(_now() + 72 hours);
        account.clearExpiredFreeze();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.GuardianCooldown.selector, _now() - 72 hours + 7 days));
        roles.guardianFreeze();
        vm.warp(_now() + 4 days);
        vm.prank(guardian);
        roles.guardianFreeze();
    }

    function test_guardianFreeze_neverShortensLongerFreeze() public {
        vm.prank(vault);
        roles.vaultFreeze();
        vm.prank(guardian);
        roles.guardianFreeze();
        assertEq(account.getHotConfig().frozenUntil, type(uint48).max);
    }

    function test_guardian_unauthorizedAndRemoval() public {
        vm.prank(stranger);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.guardianFreeze();
        vm.prank(vault);
        roles.vaultSetGuardian(guardian, false);
        vm.prank(guardian);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.guardianFreeze();
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(0)));
        roles.vaultSetGuardian(address(0), true);
    }

    function test_guardianPauses_userResumes() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        vm.prank(vault);
        roles.vaultUnfreeze();
        _hot(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
    }

    // ------------------------------------------------------------------------------------ recovery ------

    function test_recoveryCancel_anyOp() public {
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(_spend(stranger, 1), 0);
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.recoveryCancel(op);
        vm.expectEmit(address(account));
        emit ILeakedAccount.QueueCancelled(op, recovery);
        vm.prank(recovery);
        roles.recoveryCancel(op);
        vm.prank(recovery);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, op));
        roles.recoveryCancel(op);
    }

    function test_rotation_vaultCannotStopIt_I4() public {
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(_spend(stranger, 1), 0);
        vm.expectEmit(address(account));
        emit ILeakedAccount.VaultRotationStarted(newVault, _now() + 7 days);
        vm.prank(recovery);
        roles.recoveryStartVaultRotation(newVault);
        assertTrue(account.getHotConfig().hotFrozen);

        // the vault can neither spend, queue, execute, upgrade, migrate, unfreeze, nor cancel the rotation
        vm.startPrank(vault);
        vm.expectRevert(ILeakedAccount.RotationPending.selector);
        roles.vaultExecute(_spend(stranger, 1), 0);
        vm.expectRevert(ILeakedAccount.RotationPending.selector);
        roles.vaultQueue(_spend(stranger, 1), 0);
        vm.expectRevert(ILeakedAccount.RotationPending.selector);
        roles.vaultUnfreeze();
        vm.expectRevert(ILeakedAccount.RotationPending.selector);
        roles.vaultQueueUpgrade(address(impl));
        vm.expectRevert(ILeakedAccount.RotationPending.selector);
        roles.vaultQueueMigrate(stranger, new address[](0));
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.recoveryCancelVaultRotation();
        vm.stopPrank();
        vm.warp(_now() + DELAY);
        vm.expectRevert(ILeakedAccount.RotationPending.selector);
        roles.executeQueued(op, _spend(stranger, 1));
        vm.expectRevert(ILeakedAccount.RotationPending.selector);
        account.clearExpiredFreeze();

        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.RotationNotReady.selector, _now() - DELAY + 7 days));
        roles.recoveryFinalizeVaultRotation();
        vm.warp(_now() - DELAY + 7 days);
        vm.prank(stranger);
        roles.recoveryFinalizeVaultRotation();
        (address v,, address p, uint48 eta, uint32 epoch) = roles.getRoles();
        assertEq(v, newVault);
        assertEq(p, address(0));
        assertEq(eta, 0);
        assertEq(epoch, 1);
        assertFalse(account.getHotConfig().hotFrozen);
        // the old vault's op is void, and the old vault has no authority
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, op));
        roles.executeQueued(op, _spend(stranger, 1));
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultFreeze();
        vm.prank(newVault);
        roles.vaultFreeze();
    }

    function test_rotation_cancelAndRestartAndReverts() public {
        vm.prank(stranger);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.recoveryStartVaultRotation(newVault);
        address[4] memory bad = [address(0), address(account), vault, recovery];
        for (uint256 i; i < 4; ++i) {
            vm.prank(recovery);
            vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, bad[i]));
            roles.recoveryStartVaultRotation(bad[i]);
        }
        vm.prank(recovery);
        vm.expectRevert(ILeakedAccount.NoRotationPending.selector);
        roles.recoveryCancelVaultRotation();
        vm.expectRevert(ILeakedAccount.NoRotationPending.selector);
        roles.recoveryFinalizeVaultRotation();
        vm.prank(recovery);
        roles.recoveryStartVaultRotation(newVault);
        vm.expectEmit(address(account));
        emit ILeakedAccount.VaultRotationCancelled(newVault);
        vm.prank(recovery);
        roles.recoveryCancelVaultRotation();
        vm.prank(vault);
        roles.vaultUnfreeze(); // allowed again once no rotation is pending
    }

    function test_rotation_keepsLongerFreeze() public {
        vm.prank(vault);
        roles.vaultFreeze();
        vm.prank(recovery);
        roles.recoveryStartVaultRotation(newVault);
        vm.warp(_now() + 7 days);
        roles.recoveryFinalizeVaultRotation();
        assertTrue(account.getHotConfig().hotFrozen);
    }

    // ------------------------------------------------------------------------------------- upgrade ------

    function test_upgrade_timelocked() public {
        LeakedAccountImplV2 v2 = new LeakedAccountImplV2(Devnet.ERC8421_WORKSHOP, true, address(rolesModule));
        vm.prank(vault);
        bytes32 op = roles.vaultQueueUpgrade(address(v2));
        (bytes32 pOp, address pImpl,) = roles.getPending();
        assertEq(pOp, op);
        assertEq(pImpl, address(v2));
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.OpNotReady.selector, op, _now() + DELAY));
        roles.executeUpgrade(address(v2));
        vm.warp(_now() + DELAY);
        vm.expectRevert(ILeakedAccount.PayloadMismatch.selector);
        roles.executeUpgrade(address(impl));
        vm.prank(stranger);
        roles.executeUpgrade(address(v2));
        assertEq(LeakedAccountImplV2(payable(address(account))).version(), 2);
        // storage survived
        assertEq(account.getHotConfig().hotKey, hot);
    }

    function test_upgrade_directCallsRefused() public {
        LeakedAccountImplV2 v2 = new LeakedAccountImplV2(Devnet.ERC8421_WORKSHOP, true, address(rolesModule));
        vm.expectRevert(ILeakedAccount.UpgradeNotAuthorized.selector);
        account.upgradeToAndCall(address(v2), "");
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.UpgradeNotAuthorized.selector);
        account.upgradeToAndCall(address(v2), "");
        vm.prank(address(account));
        vm.expectRevert(ILeakedAccount.UpgradeNotAuthorized.selector);
        account.upgradeToAndCall(address(v2), "");
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, stranger));
        roles.vaultQueueUpgrade(stranger);
    }

    function test_upgrade_recoveryCancels_andReplacing() public {
        LeakedAccountImplV2 v2 = new LeakedAccountImplV2(Devnet.ERC8421_WORKSHOP, true, address(rolesModule));
        vm.prank(vault);
        bytes32 op1 = roles.vaultQueueUpgrade(address(v2));
        vm.prank(vault);
        bytes32 op2 = roles.vaultQueueUpgrade(address(v2)); // replaces op1
        assertEq(uint256(roles.getQueued(op1).state), uint256(ILeakedAccount.OpState.CANCELLED));
        vm.prank(recovery);
        roles.recoveryCancel(op2);
        (bytes32 pOp,,) = roles.getPending();
        assertEq(pOp, bytes32(0));
        vm.warp(_now() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, bytes32(0)));
        roles.executeUpgrade(address(v2));
    }

    function test_upgrade_toNonUUPSFails() public {
        NotUUPS bad = new NotUUPS();
        vm.prank(vault);
        roles.vaultQueueUpgrade(address(bad));
        vm.warp(_now() + DELAY);
        vm.expectRevert();
        roles.executeUpgrade(address(bad));
    }

    // ------------------------------------------------------------------------------------- migrate ------

    function test_migrate() public {
        address next = makeAddr("nextAccount");
        address[] memory toks = new address[](2);
        toks[0] = address(usdc);
        toks[1] = address(weth);
        vm.prank(vault);
        bytes32 op = roles.vaultQueueMigrate(next, toks);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.OpNotReady.selector, op, _now() + DELAY));
        roles.executeMigrate(next, toks);
        vm.warp(_now() + DELAY);
        vm.expectRevert(ILeakedAccount.PayloadMismatch.selector);
        roles.executeMigrate(stranger, toks);
        uint256 bal = usdc.balanceOf(address(account));
        vm.expectEmit(address(account));
        emit ILeakedAccount.Migrated(next);
        roles.executeMigrate(next, toks);
        assertEq(usdc.balanceOf(next), bal);
        assertEq(weth.balanceOf(next), 100 ether);
        assertEq(next.balance, 100 ether);
        ILeakedAccount.HotConfig memory c = account.getHotConfig();
        assertEq(c.hotKey, address(0));
        assertTrue(c.hotFrozen);
    }

    function test_migrate_reverts() public {
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(0)));
        roles.vaultQueueMigrate(address(0), new address[](0));
        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.TooManyTokens.selector);
        roles.vaultQueueMigrate(stranger, new address[](33));
        vm.prank(stranger);
        vm.expectRevert(ILeakedAccount.Unauthorized.selector);
        roles.vaultQueueMigrate(stranger, new address[](0));
        vm.prank(vault);
        bytes32 op = roles.vaultQueueMigrate(stranger, new address[](0));
        vm.prank(recovery);
        roles.recoveryCancel(op);
        vm.warp(_now() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadOp.selector, bytes32(0)));
        roles.executeMigrate(stranger, new address[](0));
    }

    // ------------------------------------------------------------------------------------------ fuzz ------

    function testFuzz_vaultSetCap_classification(uint256 cap, uint256 perTx, uint256 fee, uint8 frames) public {
        cap = bound(cap, 0, 1e30);
        perTx = bound(perTx, 0, type(uint96).max);
        fee = bound(fee, 0, type(uint128).max);
        frames = uint8(bound(frames, 2, 64));
        bool loosening = cap > CAP || perTx > PER_TX || fee > MAX_FEE_WEI || frames > 4;
        vm.prank(vault);
        if (loosening) vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetCap(cap, perTx, fee, frames);
    }

    function testFuzz_queueEta(uint48 delay, uint32 wait) public {
        delay = uint48(bound(delay, DELAY, 30 days));
        vm.prank(vault);
        roles.vaultSetTimelock(delay, THRESHOLD);
        ILeakedAccount.Call[] memory c = _spend(stranger, 1);
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(c, 0);
        uint48 eta = roles.getQueued(op).eta;
        assertEq(eta, _now() + delay);
        vm.warp(_now() + wait);
        if (_now() < eta) vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.OpNotReady.selector, op, eta));
        roles.executeQueued(op, c);
    }

    function testFuzz_guardianCooldown(uint32 gap) public {
        vm.prank(guardian);
        roles.guardianFreeze();
        uint48 first = _now();
        vm.warp(_now() + gap);
        vm.prank(guardian);
        if (gap < 7 days) {
            vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.GuardianCooldown.selector, first + 7 days));
        }
        roles.guardianFreeze();
    }
}

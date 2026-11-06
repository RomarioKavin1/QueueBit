// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountImpl} from "../../src/account/QueueBitAccountImpl.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {RollingCap} from "../../src/lib/RollingCap.sol";
import {AccountTestBase} from "./AccountTestBase.sol";
import {MockToken, NoReturnToken, FalseToken, ReentrantToken, RejectEth, MockRouter} from "./mocks/AccountMocks.sol";

/// `hotExecute`, `registerHash`, `clearExpiredFreeze`, prices and the bucket (§10.3.3, §10.3.4).
contract HotExecuteTest is AccountTestBase {
    bytes4 internal constant APPROVE = IERC20.approve.selector;

    function _two(IQueueBitAccount.Call memory a, IQueueBitAccount.Call memory b)
        internal
        pure
        returns (IQueueBitAccount.Call[] memory c)
    {
        c = new IQueueBitAccount.Call[](2);
        c[0] = a;
        c[1] = b;
    }

    // ------------------------------------------------------------------------------------- happy paths ------

    function test_erc20Transfer_debitsBucket() public {
        vm.expectEmit(address(account));
        emit IQueueBitAccount.HotExecuted(100 * USD, CAP - 100 * USD, 1);
        _hot(100 * USD, _one(_usdcTransfer(alice, 100 * USD)));
        assertEq(usdc.balanceOf(alice), 100 * USD);
        assertEq(_bucketAvailable(), CAP - 100 * USD);
    }

    function test_ethSend_pricedAtStaticPrice() public {
        _hot(30 * USD, _one(_ethSend(alice, 0.01 ether))); // 0.01 ETH x $3000
        assertEq(alice.balance, 0.01 ether);
        assertEq(_bucketAvailable(), CAP - 30 * USD);
    }

    function test_tankIsAllowlistedAtInitialize_topUpIsEverydayPayment() public {
        assertTrue(account.isTarget(tank));
        uint256 before = tank.balance;
        _hot(3 * USD, _one(_ethSend(tank, 0.001 ether)));
        assertEq(tank.balance, before + 0.001 ether);
    }

    function test_weth18Decimals_roundsUp() public {
        IQueueBitAccount.Call memory c =
            IQueueBitAccount.Call(address(weth), 0, abi.encodeCall(IERC20.transfer, (alice, 1))); // 1 wei of WETH
        _hot(1, _one(c));
        assertEq(_bucketAvailable(), CAP - 1, "1 wei costs the minimum unit, never zero");
    }

    function test_noReturnToken_supported() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(address(account), 1000);
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetToken, (address(t), true, 0, 1 * USD)));
        _hot(5 * USD, _one(IQueueBitAccount.Call(address(t), 0, abi.encodeCall(IERC20.transfer, (alice, 5)))));
        assertEq(t.balanceOf(alice), 5);
    }

    function test_falseReturningToken_reverts() public {
        FalseToken t = new FalseToken();
        t.mint(address(account), 1000);
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetToken, (address(t), true, 0, 1 * USD)));
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.TransferFailed.selector, address(t)));
        _hot(5 * USD, _one(IQueueBitAccount.Call(address(t), 0, abi.encodeCall(IERC20.transfer, (alice, 5)))));
    }

    function test_bucketRefillsContinuously_andFullAt() public {
        _hot(PER_TX, _one(_usdcTransfer(alice, PER_TX)));
        _hot(PER_TX, _one(_usdcTransfer(alice, PER_TX)));
        (uint256 avail, uint48 last, uint256 cap, uint48 fullAt) = account.getBucket();
        assertEq(avail, 0);
        assertEq(cap, CAP);
        assertEq(last, vm.getBlockTimestamp());
        assertEq(fullAt, vm.getBlockTimestamp() + 1 days);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        (avail,,, fullAt) = account.getBucket();
        assertEq(avail, CAP / 4);
        assertEq(fullAt, vm.getBlockTimestamp() + 18 hours);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        (avail,,, fullAt) = account.getBucket();
        assertEq(avail, CAP);
        assertEq(fullAt, vm.getBlockTimestamp());
    }

    function test_multiCallBatch() public {
        _hot(20 * USD, _two(_usdcTransfer(alice, 10 * USD), _ethSend(alice, 0.003 ether)));
        assertEq(_bucketAvailable(), CAP - 19 * USD);
    }

    // ------------------------------------------------------------------------------------------ reverts ------

    function test_revert_notSelf() public {
        vm.expectRevert(IQueueBitAccount.OnlySelf.selector);
        account.hotExecute(1, _one(_usdcTransfer(alice, 1)));
        vm.prank(hot); // the hot key's EOA has no authority at all (C3)
        vm.expectRevert(IQueueBitAccount.OnlySelf.selector);
        account.hotExecute(1, _one(_usdcTransfer(alice, 1)));
    }

    function test_revert_frozen() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        vm.expectRevert(IQueueBitAccount.HotFrozen.selector);
        _hot(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
    }

    function test_revert_bunker() public virtual {
        vm.prank(vault);
        roles.vaultEnableBunker();
        vm.expectRevert(IQueueBitAccount.BunkerActive.selector);
        _hot(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
    }

    function test_revert_callCount() public {
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.BadCallCount.selector, 0));
        _hot(0, new IQueueBitAccount.Call[](0));
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](9);
        for (uint256 i; i < 9; ++i) {
            c[i] = _usdcTransfer(alice, 1);
        }
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.BadCallCount.selector, 9));
        _hot(9, c);
    }

    function test_strict_revert_recipientNotAllowlisted() public {
        _strict();
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, stranger, IERC20.transfer.selector)
        );
        _hot(1 * USD, _one(_usdcTransfer(stranger, 1 * USD)));
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, stranger, bytes4(0)));
        _hot(1 * USD, _one(_ethSend(stranger, 1)));
        // allowlisted recipients (and the tank) still work
        _hot(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        _hot(3 * USD, _one(_ethSend(tank, 0.001 ether)));
    }

    // --------------------------------------------------------------------------- Open recipient mode ------

    function test_open_isDefault_anyRecipient_ethAndToken() public {
        assertEq(uint256(account.recipientMode()), uint256(IQueueBitAccount.RecipientMode.Open));
        assertFalse(account.isTarget(stranger));
        vm.expectEmit(address(account));
        emit IQueueBitAccount.HotExecuted(130 * USD, CAP - 130 * USD, 2);
        _hot(130 * USD, _two(_usdcTransfer(stranger, 100 * USD), _ethSend(stranger, 0.01 ether)));
        assertEq(usdc.balanceOf(stranger), 100 * USD);
        assertEq(stranger.balance, 0.01 ether);
        assertEq(_bucketAvailable(), CAP - 130 * USD, "debited like an allowlisted payment");
    }

    function test_open_capPerTxAndDeclaredStillHold() public {
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.PerTxMaxExceeded.selector, PER_TX + 1, PER_TX));
        _hot(PER_TX + 1, _one(_usdcTransfer(stranger, PER_TX + 1)));
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.DeclaredUsdExceeded.selector, 2 * USD, 1 * USD));
        _hot(1 * USD, _one(_usdcTransfer(stranger, 2 * USD)));
        _hot(PER_TX, _one(_usdcTransfer(stranger, PER_TX)));
        _hot(PER_TX, _one(_usdcTransfer(makeAddr("carol"), PER_TX)));
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 1, 0));
        _hot(1, _one(_usdcTransfer(makeAddr("dave"), 1)));
        assertEq(usdc.balanceOf(makeAddr("dave")), 0);
    }

    function test_open_ethUnpricedStillRefused() public {
        vm.prank(vault);
        roles.vaultSetToken(address(0), false, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.TokenNotAllowed.selector, address(0)));
        _hot(1 * USD, _one(_ethSend(stranger, 1)));
    }

    /// Open widens recipients of value transfers only: a zero-value empty call (it would run an arbitrary
    /// fallback), ETH with calldata, a burn to address(0), and every non-`transfer` selector need the allowlist or a
    /// session exactly as in Strict.
    function test_open_nonTransferCallsStillNeedPolicy() public {
        RejectEth sink = new RejectEth();
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(sink), bytes4(0)));
        _hot(0, _one(IQueueBitAccount.Call(address(sink), 0, "")));
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, stranger, bytes4(0xdeadbeef)));
        _hot(1 * USD, _one(IQueueBitAccount.Call(stranger, 1, hex"deadbeef")));
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(0), bytes4(0)));
        _hot(1 * USD, _one(_ethSend(address(0), 1)));
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(0), IERC20.transfer.selector)
        );
        _hot(1 * USD, _one(_usdcTransfer(address(0), 1)));
        bytes[4] memory bad = [
            abi.encodeCall(IERC20.approve, (stranger, 1)),
            abi.encodeCall(IERC20.transferFrom, (address(account), stranger, 1)),
            abi.encodeWithSelector(bytes4(0x39509351), stranger, 1), // increaseAllowance
            abi.encodeWithSelector(bytes4(0xd505accf), address(account), stranger, 1, 1, 27, 0, 0) // permit
        ];
        for (uint256 i; i < 4; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(usdc), bytes4(bad[i])));
            _hot(1 * USD, _one(IQueueBitAccount.Call(address(usdc), 0, bad[i])));
        }
        assertEq(usdc.allowance(address(account), stranger), 0);
    }

    function testFuzz_open_anyEoaRecipient_debitEqualsQuote(address to, uint96 amount) public {
        vm.assume(to != address(0) && to != address(account) && to.code.length == 0 && uint160(to) > 0xffff);
        // Self-defeating recipients are refused (`ForbiddenRecipient`, AccountHardening.t.sol).
        vm.assume(to != vault && to != recovery && to != guardian);
        uint256 amt = bound(amount, 1, PER_TX);
        uint256 before = usdc.balanceOf(to);
        _hot(amt, _one(_usdcTransfer(to, amt)));
        assertEq(usdc.balanceOf(to), before + amt);
        assertEq(_bucketAvailable(), CAP - amt);
    }

    function test_revert_tokenNotAllowlisted_H2() public {
        // A CryptoKitties-style `transfer(address,uint256)` on a contract that is not an allowlisted token.
        MockToken kitty = new MockToken("KITTY", 0);
        kitty.mint(address(account), 5);
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(kitty), IERC20.transfer.selector)
        );
        _hot(1, _one(IQueueBitAccount.Call(address(kitty), 0, abi.encodeCall(IERC20.transfer, (alice, 1)))));
    }

    function test_revert_otherSelectorOnToken() public {
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(usdc), APPROVE));
        _hot(0, _one(IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (alice, 1)))));
    }

    function test_revert_tokenTransferWithValueOrBadLength() public {
        IQueueBitAccount.Call memory c = _usdcTransfer(alice, 1);
        c.value = 1;
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(usdc), IERC20.transfer.selector)
        );
        _hot(1, _one(c));
        c.value = 0;
        c.data = abi.encodePacked(c.data, uint256(0));
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(usdc), IERC20.transfer.selector)
        );
        _hot(1, _one(c));
    }

    function test_revert_selfCallOtherThanRegisterOrClear() public {
        IQueueBitAccount.Call memory c = _selfCall(abi.encodeCall(QueueBitAccountRoles.vaultFreeze, ()));
        vm.expectRevert(
            abi.encodeWithSelector(
                IQueueBitAccount.NotAllowed.selector, address(account), QueueBitAccountRoles.vaultFreeze.selector
            )
        );
        _hot(0, _one(c));
        c = _selfCall(abi.encodeCall(QueueBitAccountImpl.clearExpiredFreeze, ()));
        c.value = 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IQueueBitAccount.NotAllowed.selector, address(account), QueueBitAccountImpl.clearExpiredFreeze.selector
            )
        );
        _hot(0, _one(c));
    }

    function test_revert_declaredTooLow() public {
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.DeclaredUsdExceeded.selector, 10 * USD, 9 * USD));
        _hot(9 * USD, _one(_usdcTransfer(alice, 10 * USD)));
    }

    function test_revert_perTxMax() public {
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.PerTxMaxExceeded.selector, PER_TX + 1, PER_TX));
        _hot(type(uint256).max, _one(_usdcTransfer(alice, PER_TX + 1)));
    }

    function test_revert_overCap() public {
        _hot(PER_TX, _one(_usdcTransfer(alice, PER_TX)));
        _hot(PER_TX - 1, _one(_usdcTransfer(alice, PER_TX - 1)));
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 2, 1));
        _hot(2, _one(_usdcTransfer(alice, 2)));
    }

    function test_revert_ethUnpriced() public {
        vm.prank(vault);
        roles.vaultSetToken(address(0), false, 0, 0); // removal is instant
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.TokenNotAllowed.selector, address(0)));
        _hot(1, _one(_ethSend(alice, 1)));
    }

    function test_revert_callFailedBubbles() public {
        RejectEth r = new RejectEth();
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (address(r), true)));
        vm.expectRevert(
            abi.encodeWithSelector(
                IQueueBitAccount.CallFailed.selector, 0, abi.encodeWithSignature("Error(string)", "no eth")
            )
        );
        _hot(10 * USD, _one(_ethSend(address(r), 1)));
    }

    // ----------------------------------------------------------------------------------------- sessions ------

    function _routerSession(uint256 allowance) internal {
        uint48 exp = uint48(vm.getBlockTimestamp() + 30 days);
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](3);
        c[0] = _selfCall(abi.encodeCall(QueueBitAccountRoles.vaultSetSession, (address(usdc), APPROVE, allowance, exp)));
        c[1] = _selfCall(
            abi.encodeCall(
                QueueBitAccountRoles.vaultSetSession, (address(router), MockRouter.pull.selector, allowance, exp)
            )
        );
        c[2] = _selfCall(
            abi.encodeCall(
                QueueBitAccountRoles.vaultSetSession, (address(router), MockRouter.pullPartial.selector, allowance, exp)
            )
        );
        _queueAndExecute(c, 1);
    }

    function _approveAndPull(uint256 amount, address to) internal view returns (IQueueBitAccount.Call[] memory) {
        return _two(
            IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(router), amount))),
            IQueueBitAccount.Call(address(router), 0, abi.encodeCall(MockRouter.pull, (usdc, amount, to)))
        );
    }

    function test_session_balanceDeltaDebited_H4() public {
        _routerSession(200 * USD);
        // The router sweeps to a third party: whatever leaves is counted, not the calldata's claim.
        _hot(50 * USD, _approveAndPull(50 * USD, stranger));
        assertEq(usdc.balanceOf(stranger), 50 * USD);
        assertEq(_bucketAvailable(), CAP - 50 * USD);
        assertEq(account.getSession(address(router), MockRouter.pull.selector).allowanceUsd, 150 * USD);
        assertEq(account.getSession(address(usdc), APPROVE).allowanceUsd, 200 * USD, "approve moved nothing");
    }

    function test_session_allowanceExceeded() public {
        _routerSession(40 * USD);
        bytes32 sid = account.sessionId(address(router), MockRouter.pull.selector);
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.SessionAllowanceExceeded.selector, sid, 50 * USD, 40 * USD)
        );
        _hot(50 * USD, _approveAndPull(50 * USD, alice));
    }

    function test_session_expired() public {
        _routerSession(200 * USD);
        vm.warp(vm.getBlockTimestamp() + 31 days);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(usdc), APPROVE));
        _hot(50 * USD, _approveAndPull(50 * USD, alice));
    }

    function test_session_standingApprovalReverts_I6() public {
        _routerSession(200 * USD);
        IQueueBitAccount.Call[] memory c = _two(
            IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(router), 50 * USD))),
            IQueueBitAccount.Call(address(router), 0, abi.encodeCall(MockRouter.pullPartial, (usdc, 50 * USD, alice)))
        );
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.StandingApproval.selector, address(usdc), address(router))
        );
        _hot(50 * USD, c);
    }

    function test_session_ethValueMeasured() public {
        _queueLoosen(
            abi.encodeCall(
                QueueBitAccountRoles.vaultSetSession,
                (address(router), MockRouter.noop.selector, 100 * USD, uint48(vm.getBlockTimestamp() + 30 days))
            )
        );
        _hot(30 * USD, _one(IQueueBitAccount.Call(address(router), 0.01 ether, abi.encodeCall(MockRouter.noop, ()))));
        assertEq(_bucketAvailable(), CAP - 30 * USD);
    }

    function test_session_unknownTargetRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(router), MockRouter.noop.selector)
        );
        _hot(0, _one(IQueueBitAccount.Call(address(router), 0, abi.encodeCall(MockRouter.noop, ()))));
    }

    // ----------------------------------------------------------------------------------- registerHash ------

    function _register(bytes32 h, uint256 amount, uint48 exp) internal view returns (IQueueBitAccount.Call memory) {
        return _selfCall(abi.encodeCall(QueueBitAccountImpl.registerHash, (h, address(usdc), amount, exp)));
    }

    function test_registerHash_debitsAndRegisters() public {
        bytes32 h = keccak256("permit");
        uint48 exp = uint48(vm.getBlockTimestamp() + 1 hours);
        vm.expectEmit(address(account));
        emit IQueueBitAccount.HashRegistered(h, address(usdc), 25 * USD, exp);
        _hot(25 * USD, _one(_register(h, 25 * USD, exp)));
        assertEq(account.registeredHashExpiry(h), exp);
        assertEq(_bucketAvailable(), CAP - 25 * USD);
    }

    function test_registerHash_declaredMustCoverIt() public {
        uint48 exp = uint48(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.DeclaredUsdExceeded.selector, 25 * USD, 0));
        _hot(0, _one(_register(keccak256("p"), 25 * USD, exp)));
    }

    function test_registerHash_reverts() public {
        uint48 exp = uint48(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert(IQueueBitAccount.OnlySelf.selector);
        account.registerHash(bytes32(0), address(usdc), 1, exp);
        vm.prank(address(account));
        vm.expectRevert(IQueueBitAccount.NotInHotBatch.selector);
        account.registerHash(bytes32(0), address(usdc), 1, exp);
        // bad expiry (past, too far) and unpriced token, inside a batch
        vm.expectRevert(
            abi.encodeWithSelector(
                IQueueBitAccount.CallFailed.selector, 0, abi.encodeWithSelector(IQueueBitAccount.BadExpiry.selector)
            )
        );
        _hot(1 * USD, _one(_register(bytes32(0), 1, uint48(vm.getBlockTimestamp()))));
        vm.expectRevert(
            abi.encodeWithSelector(
                IQueueBitAccount.CallFailed.selector, 0, abi.encodeWithSelector(IQueueBitAccount.BadExpiry.selector)
            )
        );
        _hot(1 * USD, _one(_register(bytes32(0), 1, uint48(vm.getBlockTimestamp() + 31 days))));
        IQueueBitAccount.Call memory c =
            _selfCall(abi.encodeCall(QueueBitAccountImpl.registerHash, (bytes32(0), stranger, 1, exp)));
        vm.expectRevert(
            abi.encodeWithSelector(
                IQueueBitAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(IQueueBitAccount.TokenNotAllowed.selector, stranger)
            )
        );
        _hot(1 * USD, _one(c));
    }

    // ----------------------------------------------------------------------------------- reentrancy M-e ------

    function test_reentrantToken_cannotReenter() public {
        ReentrantToken t = new ReentrantToken();
        t.mint(address(account), 1000 ether);
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetToken, (address(t), true, 18, 1 * USD)));
        // A ready queued op the token tries to execute mid-batch.
        IQueueBitAccount.Call[] memory q = _one(_usdcTransfer(stranger, 1));
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(q, 0);
        vm.warp(vm.getBlockTimestamp() + DELAY);

        t.setHook(address(account), abi.encodeCall(QueueBitAccountRoles.executeQueued, (op, q)));
        _hot(1 * USD, _one(IQueueBitAccount.Call(address(t), 0, abi.encodeCall(IERC20.transfer, (alice, 1 ether)))));
        assertFalse(t.lastOk());
        assertEq(bytes4(t.lastRet()), IQueueBitAccount.Reentrancy.selector);

        t.setHook(address(account), abi.encodeCall(QueueBitAccountImpl.registerHash, (bytes32(0), address(t), 0, 1)));
        _hot(1 * USD, _one(IQueueBitAccount.Call(address(t), 0, abi.encodeCall(IERC20.transfer, (alice, 1 ether)))));
        assertFalse(t.lastOk());
        assertEq(bytes4(t.lastRet()), IQueueBitAccount.OnlySelf.selector);
    }

    // ------------------------------------------------------------------------------- clearExpiredFreeze ------

    function test_clearExpiredFreeze() public {
        vm.expectRevert(IQueueBitAccount.NotFrozen.selector);
        account.clearExpiredFreeze();
        vm.prank(guardian);
        roles.guardianFreeze();
        uint48 until = uint48(vm.getBlockTimestamp() + 72 hours);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.FreezeNotExpired.selector, until));
        account.clearExpiredFreeze();
        vm.warp(until);
        vm.expectEmit(address(account));
        emit IQueueBitAccount.Unfrozen(stranger);
        vm.prank(stranger); // permissionless
        account.clearExpiredFreeze();
        assertFalse(account.getHotConfig().hotFrozen);
    }

    function test_clearExpiredFreeze_neverClearsVaultFreeze() public {
        vm.prank(vault);
        roles.vaultFreeze();
        vm.warp(vm.getBlockTimestamp() + 3650 days);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.FreezeNotExpired.selector, type(uint48).max));
        account.clearExpiredFreeze();
    }

    function test_quoteUsd() public view {
        assertEq(account.quoteUsd(address(usdc), 7 * USD), 7 * USD);
        assertEq(account.quoteUsd(address(weth), 1 ether), ETH_PRICE);
        assertEq(account.quoteUsd(address(0), 0.5 ether), ETH_PRICE / 2);
    }

    function test_quoteUsd_unknownToken() public {
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.TokenNotAllowed.selector, stranger));
        account.quoteUsd(stranger, 1);
    }

    // ------------------------------------------------------------------------------------------ fuzz ------

    function testFuzz_priceMath_neverUndercharges(uint256 amount, uint8 decimals, uint256 price) public {
        decimals = uint8(bound(decimals, 0, 36));
        price = bound(price, 1, 1e15 * USD);
        amount = bound(amount, 0, 1e40);
        MockToken t = new MockToken("T", decimals);
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetToken, (address(t), true, decimals, price)));
        uint256 q = account.quoteUsd(address(t), amount);
        // q >= exact value, and q - exact < 1 unit
        uint256 lhs = q * (10 ** decimals);
        uint256 exact = amount * price;
        assertGe(lhs, exact);
        assertLt(lhs - exact, 10 ** decimals);
    }

    function testFuzz_debitEqualsQuote(uint96 amount) public {
        amount = uint96(bound(amount, 0, PER_TX));
        _hot(amount, _one(_usdcTransfer(alice, amount)));
        assertEq(_bucketAvailable(), CAP - amount);
    }

    function testFuzz_spendsOverTimeBounded(uint256[8] memory amounts, uint32[8] memory gaps) public {
        uint256 t0 = vm.getBlockTimestamp();
        uint256 spent;
        for (uint256 i; i < 8; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 2 days));
            uint256 a = bound(amounts[i], 1, PER_TX);
            if (a > _bucketAvailable()) continue;
            _hot(a, _one(_usdcTransfer(alice, a)));
            spent += a;
        }
        uint256 elapsed = vm.getBlockTimestamp() - t0;
        assertLe(spent, CAP + (elapsed * CAP) / 1 days);
    }
}

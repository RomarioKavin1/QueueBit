// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC7739Utils} from "@openzeppelin/contracts/utils/cryptography/draft-ERC7739Utils.sol";
import {ILeakedAccount} from "../../src/account/ILeakedAccount.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {LeakedAccountRoles} from "../../src/account/LeakedAccountRoles.sol";
import {LeakedAccountStorage} from "../../src/account/LeakedAccountStorage.sol";
import {AccountTestBase} from "./AccountTestBase.sol";
import {PermitToken1271, MockRouter, Verifier1271, ReentrantRecipient} from "./mocks/AccountMocks.sol";

/// Security-audit regressions (2026-11-06). Each test names the finding it pins; every one of them failed on the
/// code as first implemented (the leaked hot key could do what the test forbids). This suite runs in
/// `RecipientMode.Open` (the default); `AuditStrictTest` below re-runs every PoC in `Strict`.
contract AuditTest is AccountTestBase {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant BAD = 0xffffffff;
    bytes4 internal constant APPROVE = IERC20.approve.selector;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address internal attacker = makeAddr("attacker"); // holds the leaked hot key, nothing else
    PermitToken1271 internal pusd; // allowlisted, permit via 1271 (USDC-like)
    PermitToken1271 internal dai; // held by the account, NOT allowlisted
    Verifier1271 internal dapp;

    function setUp() public virtual override {
        super.setUp();
        pusd = new PermitToken1271("pUSD");
        dai = new PermitToken1271("DAI");
        dapp = new Verifier1271();
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(pusd), true, 18, 1 * USD)));
        pusd.mint(address(account), 90_000 ether);
        dai.mint(address(account), 90_000 ether);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _personal(uint256 pk, bytes32 hash) internal view returns (bytes memory) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("LEAKED"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("PersonalSign(bytes prefixed)"), hash));
        return _sign(pk, MessageHashUtils.toTypedDataHash(ds, structHash));
    }

    /// The hot key's ERC-7739 TypedDataSign envelope over a token's ERC-2612 `Permit` typed data.
    function _permitSig7739(PermitToken1271 token, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 appSeparator = token.DOMAIN_SEPARATOR();
        bytes32 contentsHash = keccak256(
            abi.encode(
                token.PERMIT_TYPEHASH(), address(account), spender, value, token.nonces(address(account)), deadline
            )
        );
        string memory descr = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "TypedDataSign(Permit contents,string name,string version,uint256 chainId,address verifyingContract,",
                "bytes32 salt)",
                descr
            )
        );
        bytes memory domainBytes =
            abi.encode(keccak256("LEAKED"), keccak256("1"), block.chainid, address(account), bytes32(0));
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, contentsHash, domainBytes));
        bytes memory raw = _sign(hotPk, MessageHashUtils.toTypedDataHash(appSeparator, structHash));
        return ERC7739Utils.encodeTypedDataSig(raw, appSeparator, contentsHash, descr);
    }

    // ------------------------------------------------------------------ C1: registerHash with a lying amount ------

    /// A leaked hot key registers a token's permit digest for 90,000 tokens while declaring an amount of 1 wei: the
    /// token must not honour that hash (the debit is self-declared; the contract cannot read the hash's value).
    function test_C1_opaqueRegisteredHash_notHonouredByTokenOrPermit2() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = pusd.permitDigest(address(account), attacker, 90_000 ether, deadline);
        ILeakedAccount.Call memory reg =
            _selfCall(abi.encodeCall(LeakedAccountImpl.registerHash, (digest, address(pusd), 1, uint48(deadline))));
        _hot(1, _one(reg)); // debit: 1 wei of pUSD = $0.000001
        assertEq(account.registeredHashExpiry(digest), uint48(deadline));

        vm.prank(address(pusd));
        assertEq(account.isValidSignature(digest, ""), BAD, "token asks: opaque registration refused");
        vm.prank(PERMIT2);
        assertEq(account.isValidSignature(digest, ""), BAD, "Permit2 asks: refused");
        vm.expectRevert("bad sig");
        pusd.permit(address(account), attacker, 90_000 ether, deadline, "");
        vm.prank(attacker);
        vm.expectRevert();
        pusd.transferFrom(address(account), attacker, 90_000 ether);
        assertEq(pusd.balanceOf(attacker), 0);
        // the same hash stays usable where it is harmless: an off-chain (eth_call) verifier
        vm.prank(address(0));
        assertEq(account.isValidSignature(digest, ""), MAGIC);
    }

    /// The sound replacement: `registerPermit` computes the ERC-2612 digest on chain, so the debit is the permit's
    /// own value, and only that token may consume it.
    function test_C1_registerPermit_bindsValueAndToken() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = pusd.permitDigest(address(account), alice, 50 ether, deadline);
        ILeakedAccount.Call memory reg =
            _selfCall(abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, 50 ether, deadline)));
        vm.expectEmit(address(account));
        emit ILeakedAccount.HashRegistered(digest, address(pusd), 50 ether, uint48(deadline));
        _hot(50 * USD, _one(reg));
        assertEq(_bucketAvailable(), CAP - 50 * USD, "debited at the permit's value");
        assertEq(account.registeredHashConsumer(digest), address(pusd));

        bytes memory marker = abi.encodePacked(account.REGISTERED_MARKER(), digest);
        vm.prank(address(pusd));
        assertEq(account.isValidSignature(digest, ""), MAGIC);
        vm.prank(address(pusd));
        assertEq(account.isValidSignature(digest, marker), MAGIC);
        vm.prank(address(0));
        assertEq(account.isValidSignature(digest, ""), BAD, "bound to the token only");
        vm.prank(PERMIT2);
        assertEq(account.isValidSignature(digest, ""), BAD);

        pusd.permit(address(account), alice, 50 ether, deadline, "");
        vm.prank(alice);
        pusd.transferFrom(address(account), alice, 50 ether);
        assertEq(pusd.balanceOf(alice), 50 ether);
        // a second permit for the same (spender, value) is a new nonce: not registered
        assertEq(account.registeredHashExpiry(pusd.permitDigest(address(account), alice, 50 ether, deadline)), 0);
    }

    function test_C1_registerPermit_reverts() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        vm.expectRevert(ILeakedAccount.OnlySelf.selector);
        account.registerPermit(address(pusd), alice, 1, deadline);
        vm.prank(address(account));
        vm.expectRevert(ILeakedAccount.NotInHotBatch.selector);
        account.registerPermit(address(pusd), alice, 1, deadline);
        // unpriced token (not allowlisted): no debit is possible, so no registration
        ILeakedAccount.Call memory c =
            _selfCall(abi.encodeCall(LeakedAccountImpl.registerPermit, (address(dai), alice, 1, deadline)));
        vm.expectRevert(
            abi.encodeWithSelector(
                ILeakedAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(ILeakedAccount.TokenNotAllowed.selector, address(dai))
            )
        );
        _hot(1 * USD, _one(c));
        // past deadline
        c = _selfCall(
            abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, 1, vm.getBlockTimestamp()))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                ILeakedAccount.CallFailed.selector, 0, abi.encodeWithSelector(ILeakedAccount.BadExpiry.selector)
            )
        );
        _hot(1 * USD, _one(c));
        // over the per-tx bound / bucket: an "infinite" permit cannot be registered
        c = _selfCall(
            abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, type(uint256).max, deadline))
        );
        vm.expectRevert();
        _hot(type(uint256).max, _one(c));
        // a long deadline is clamped to MAX_REGISTERED_TTL
        c = _selfCall(abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, 1, deadline + 365 days)));
        _hot(1 * USD, _one(c));
        bytes32 d = pusd.permitDigest(address(account), alice, 1, deadline + 365 days);
        assertEq(account.registeredHashExpiry(d), uint48(vm.getBlockTimestamp() + 30 days));
    }

    // ------------------------------------------------- H1: 7739 "any domain" vs value-moving verifiers ------

    /// A token the account holds but the vault never allowlisted (so never priced, never denied) accepts 1271
    /// permits: with "any domain" the leaked hot key signs its permit through the 7739 envelope and drains it.
    function test_H1_nonAllowlistedPermitToken_notSignableByHotKey() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _permitSig7739(dai, attacker, 90_000 ether, deadline);
        bytes32 digest = dai.permitDigest(address(account), attacker, 90_000 ether, deadline);
        vm.prank(address(dai));
        assertEq(account.isValidSignature(digest, sig), BAD, "a contract verifier the vault never trusted");
        vm.expectRevert("bad sig");
        dai.permit(address(account), attacker, 90_000 ether, deadline, sig);
        assertEq(dai.allowance(address(account), attacker), 0);
    }

    /// What stays open without the vault: verification by eth_call (SIWE and other off-chain checks run with a
    /// code-less `from`), and the 7739 support sentinel for anyone. On-chain contract verifiers need the vault.
    function test_H1_hotKey7739_offChainOnly_unlessTrusted() public {
        bytes32 h = keccak256("Sign in to example.org");
        bytes memory sig = _personal(hotPk, h);
        vm.prank(address(0));
        assertEq(account.isValidSignature(h, sig), MAGIC, "eth_call from 0x0");
        vm.prank(stranger);
        assertEq(account.isValidSignature(h, sig), MAGIC, "eth_call from an EOA");
        assertEq(dapp.check(address(account), h, sig), BAD, "contract verifier: not trusted");
        assertEq(
            dapp.check(
                address(account), bytes32(0x7739773977397739773977397739773977397739773977397739773977397739), ""
            ),
            bytes4(0x77390001)
        );

        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetTrustedVerifier(address(dapp), true);
        ILeakedAccount.Call[] memory q =
            _one(_selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetTrustedVerifier, (address(dapp), true))));
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(q, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectEmit(address(account));
        emit ILeakedAccount.TrustedVerifierSet(address(dapp), true);
        roles.executeQueued(op, q);
        assertTrue(roles.isTrustedVerifier(address(dapp)));
        assertEq(dapp.check(address(account), h, sig), MAGIC, "trusted verifier");
        // the deny list still wins over trust (a trusted verifier that turns out to move value)
        vm.prank(vault);
        roles.vaultSetValueVerifier(address(dapp), true);
        assertEq(dapp.check(address(account), h, sig), BAD);
        vm.prank(vault);
        roles.vaultSetTrustedVerifier(address(dapp), false); // untrusting is instant
        assertFalse(roles.isTrustedVerifier(address(dapp)));
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(account)));
        roles.vaultSetTrustedVerifier(address(account), false);
    }

    // ------------------------------------------------------ M2: approvals via sessions on unmonitored assets ------

    /// Removing a token is "tightening", but a (token, approve) session outlives it and the balance-delta accounting
    /// no longer watches that token: approve + router pull would move it with a zero debit.
    function test_M2_sessionApprove_onlyOnMonitoredTokens() public {
        uint48 exp = uint48(vm.getBlockTimestamp() + 30 days);
        ILeakedAccount.Call[] memory c = new ILeakedAccount.Call[](2);
        c[0] = _selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetSession, (address(usdc), APPROVE, 1_000 * USD, exp)));
        c[1] = _selfCall(
            abi.encodeCall(
                LeakedAccountRoles.vaultSetSession, (address(router), MockRouter.pull.selector, 1_000 * USD, exp)
            )
        );
        _queueAndExecute(c, 1);
        vm.prank(vault);
        roles.vaultSetToken(address(usdc), false, 0, 0); // instant removal

        ILeakedAccount.Call[] memory batch = new ILeakedAccount.Call[](2);
        batch[0] =
            ILeakedAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(router), 50_000 * USD)));
        batch[1] =
            ILeakedAccount.Call(address(router), 0, abi.encodeCall(MockRouter.pull, (usdc, 50_000 * USD, attacker)));
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.NotAllowed.selector, address(usdc), APPROVE));
        _hot(0, batch);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    // ------------------------------------------------------------- M1: fee exposure is MAX_COST, not limits ------

    /// On the per-gas profile the payer is charged `maxFeePerGas x (intrinsic + sum of limits)`: the bound must be
    /// on TXPARAM(MAX_COST), or a batch with megabytes of calldata burns the tank far beyond `maxFeeWeiPerTx`.
    function test_M1_feeBoundUsesMaxCost() public {
        _beginHotTx(_hotData(1 * USD, _one(_usdcTransfer(alice, 1 * USD))));
        // frame limits x maxFee = 410k x 1 gwei = 0.00041 ETH, but the tx's max cost is 0.06 ETH > 0.05 bound.
        simSetFees(1 gwei, 1 gwei, 0.06 ether);
        _signHotTx();
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), ILeakedAccount.FeeTooHigh.selector);
    }

    // --------------------------------------------------------------- L1: value-bearing frames before VERIFY ------

    function test_L1_frameBeforeWithValueRefused() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simAddFrame(MODE_DEFAULT, 0, address(factory), 50_000, 0, 1 wei, "");
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _hotData(1 * USD, _one(_usdcTransfer(alice, 1 * USD))));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        simEnter(1);
        vm.prank(ENTRY_POINT);
        (bool ok, bytes memory ret) = address(account).call(_verifyData());
        simLeave(1, STATUS_FAILED);
        assertFalse(ok);
        assertEq(bytes4(ret), ILeakedAccount.BadFrameBefore.selector);
    }

    // ------------------------------------------------------------------------- I-2: VERIFY reads vs hot writes ------

    /// The slots VERIFY reads are the three packed policy slots (and the proxy's implementation slot); a hot batch
    /// writes none of them (C4: nothing a leaked hot key does can invalidate its own pending transactions).
    function test_I2_verifyReadsOnlyRoleWrittenSlots() public {
        _beginHotTx(_hotData(1 * USD, _one(_usdcTransfer(alice, 1 * USD))));
        _signHotTx();
        vm.record();
        simEnter(0);
        vm.prank(ENTRY_POINT);
        (bool ok,) = address(account).call(_verifyData());
        simLeave(0, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertTrue(ok);
        (bytes32[] memory reads, bytes32[] memory vwrites) = vm.accesses(address(account));
        assertEq(vwrites.length, 0, "VERIFY wrote storage");
        assertGt(reads.length, 0);
        uint256 base = uint256(LeakedAccountStorage.SLOT);
        for (uint256 i; i < reads.length; ++i) {
            uint256 s = uint256(reads[i]);
            assertTrue(
                s == base || s == base + 1 || s == base + 2 || reads[i] == ERC1967Utils.IMPLEMENTATION_SLOT,
                "VERIFY read an execution-side slot"
            );
        }

        vm.record();
        uint48 exp = uint48(vm.getBlockTimestamp() + 1 hours);
        ILeakedAccount.Call[] memory c = new ILeakedAccount.Call[](3);
        c[0] = _usdcTransfer(alice, 1 * USD);
        c[1] = _ethSend(alice, 1 wei);
        c[2] = _selfCall(abi.encodeCall(LeakedAccountImpl.registerHash, (keccak256("h"), address(usdc), 1, exp)));
        _hot(2 * USD, c);
        (, bytes32[] memory hwrites) = vm.accesses(address(account));
        assertGt(hwrites.length, 0);
        for (uint256 i; i < hwrites.length; ++i) {
            for (uint256 j; j < reads.length; ++j) {
                assertTrue(hwrites[i] != reads[j], "hot batch wrote a VERIFY-read slot");
            }
        }
    }

    /// I-2 with the recipient policy: an Open-mode payment to an arbitrary recipient writes no VERIFY-read slot, and
    /// the mode itself lives outside the three VERIFY slots (VERIFY never reads it; the walker needs no recipient).
    function test_I2_recipientModeSlotDisjointFromVerify() public virtual {
        _beginHotTx(_hotData(2 * USD, _one(_usdcTransfer(stranger, 2 * USD))));
        _signHotTx();
        vm.record();
        simEnter(0);
        vm.prank(ENTRY_POINT);
        (bool ok,) = address(account).call(_verifyData());
        simLeave(0, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertTrue(ok, "VERIFY admits the arbitrary-recipient payment without reading it");
        (bytes32[] memory reads,) = vm.accesses(address(account));

        vm.record();
        ILeakedAccount.Call[] memory c = new ILeakedAccount.Call[](2);
        c[0] = _usdcTransfer(stranger, 1 * USD);
        c[1] = _ethSend(makeAddr("carol"), 1 wei);
        _hot(2 * USD, c);
        (bytes32[] memory hreads, bytes32[] memory hwrites) = vm.accesses(address(account));
        vm.record();
        vm.prank(vault);
        roles.vaultSetRecipientMode(ILeakedAccount.RecipientMode.Strict);
        (, bytes32[] memory mwrites) = vm.accesses(address(account));
        assertEq(mwrites.length, 1, "the mode is one slot");
        bool hotReadsMode;
        for (uint256 j; j < hreads.length; ++j) {
            if (hreads[j] == mwrites[0]) hotReadsMode = true;
        }
        assertTrue(hotReadsMode, "execution reads the mode slot");
        uint256 base = uint256(LeakedAccountStorage.SLOT);
        assertGt(uint256(mwrites[0]), base + 2, "mode slot is execution-side");
        for (uint256 j; j < reads.length; ++j) {
            assertTrue(reads[j] != mwrites[0], "VERIFY read the mode slot");
            for (uint256 i; i < hwrites.length; ++i) {
                assertTrue(hwrites[i] != reads[j], "Open-mode hot batch wrote a VERIFY-read slot");
            }
        }
    }

    /// Open mode does not widen the token rule: a held but unallowlisted (unpriced) token cannot be transferred to
    /// anyone, so every hot outflow stays priced and debited.
    function test_open_unpricedTokenNeverTransferable() public {
        vm.expectRevert(
            abi.encodeWithSelector(ILeakedAccount.NotAllowed.selector, address(dai), IERC20.transfer.selector)
        );
        _hot(1 * USD, _one(ILeakedAccount.Call(address(dai), 0, abi.encodeCall(IERC20.transfer, (attacker, 1 ether)))));
        assertEq(dai.balanceOf(attacker), 0);
    }

    // ------------------------------------------- delta review 2026-11-06: Open-mode payee reentry, mode slot ------

    /// An Open-mode payee is an arbitrary contract whose `receive` runs with the account as caller while the hot
    /// batch is open (in Strict the same contract is reached once allowlisted). It gains nothing: no hot batch of
    /// its own (`OnlySelf`), no ready queued loosening (Strict -> Open) executed mid-batch (`Reentrancy`), no mode
    /// change (`Unauthorized`); and refunding part of the payment does not net the debit (max(static, measured)).
    function test_open_recipientReentry_cannotEscalate_andNoNetting() public {
        ReentrantRecipient payee = new ReentrantRecipient();
        bool strict = account.recipientMode() == ILeakedAccount.RecipientMode.Strict;
        if (strict) _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetTarget, (address(payee), true)));
        // A ready Strict -> Open op (an Open -> Open no-op in the Open suite) the payee tries to run mid-batch.
        ILeakedAccount.Call[] memory q = _one(
            _selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetRecipientMode, (ILeakedAccount.RecipientMode.Open)))
        );
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(q, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);

        uint256 pay = 0.001 ether; // $3
        bytes[3] memory hooks = [
            abi.encodeCall(LeakedAccountImpl.hotExecute, (1 * USD, _one(_usdcTransfer(attacker, 1 * USD)))),
            abi.encodeCall(LeakedAccountRoles.executeQueued, (op, q)),
            abi.encodeCall(LeakedAccountRoles.vaultSetRecipientMode, (ILeakedAccount.RecipientMode.Open))
        ];
        bytes4[3] memory errs = [
            ILeakedAccount.OnlySelf.selector, ILeakedAccount.Reentrancy.selector, ILeakedAccount.Unauthorized.selector
        ];
        for (uint256 i; i < 3; ++i) {
            payee.setHook(address(account), hooks[i]);
            uint256 before = _bucketAvailable();
            _hot(3 * USD, _one(_ethSend(address(payee), pay)));
            assertFalse(payee.lastOk(), "the payee's reentry succeeded");
            assertEq(bytes4(payee.lastRet()), errs[i]);
            assertEq(before - _bucketAvailable(), 3 * USD, "debited the payment");
        }
        assertEq(usdc.balanceOf(attacker), 0);
        assertTrue(roles.isQueued(op), "the loosening stays pending");
        assertEq(uint256(account.recipientMode()), strict ? 1 : 0, "the mode did not change mid-batch");

        payee.setHook(address(0), "");
        payee.setRefund(pay / 2);
        uint256 bucket = _bucketAvailable();
        uint256 bal = address(account).balance;
        _hot(3 * USD, _one(_ethSend(address(payee), pay)));
        assertEq(bal - address(account).balance, pay / 2, "half came back");
        assertEq(bucket - _bucketAvailable(), 3 * USD, "a refund does not net the debit");
    }

    /// The mode slot's zero value is Strict: an account upgraded from an implementation without the field (its
    /// appended slot is zero) keeps the recipient allowlist until the vault queues Strict -> Open, which is the one
    /// path that writes the non-zero (Open) value.
    function test_modeSlot_zeroIsStrict_failClosedAfterUpgrade() public {
        vm.record();
        vm.prank(vault);
        roles.vaultSetRecipientMode(ILeakedAccount.RecipientMode.Strict);
        (, bytes32[] memory w) = vm.accesses(address(account));
        assertEq(w.length, 1, "the mode is one slot");
        assertEq(vm.load(address(account), w[0]), bytes32(0), "Strict is the zero value");
        assertEq(uint256(account.recipientMode()), uint256(ILeakedAccount.RecipientMode.Strict));
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.NotAllowed.selector, stranger, bytes4(0)));
        _hot(1, _one(_ethSend(stranger, 1)));
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetRecipientMode, (ILeakedAccount.RecipientMode.Open)));
        assertEq(uint256(vm.load(address(account), w[0])), 1, "Open is the non-zero value");
        assertEq(uint256(account.recipientMode()), uint256(ILeakedAccount.RecipientMode.Open));
    }
}

/// Every audit PoC above, re-run with the recipient allowlist (`RecipientMode.Strict`).
contract AuditStrictTest is AuditTest {
    function setUp() public override {
        super.setUp();
        _strict();
        assertEq(uint256(account.recipientMode()), uint256(ILeakedAccount.RecipientMode.Strict));
    }

    /// In Strict the arbitrary-recipient leg is refused in execution (VERIFY is unchanged); the I-2 slot argument
    /// is checked with an allowlisted recipient instead.
    function test_I2_recipientModeSlotDisjointFromVerify() public override {
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.NotAllowed.selector, stranger, IERC20.transfer.selector));
        _hot(1 * USD, _one(_usdcTransfer(stranger, 1 * USD)));
        test_I2_verifyReadsOnlyRoleWrittenSlots();
    }
}

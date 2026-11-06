// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountImpl} from "../../src/account/QueueBitAccountImpl.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {QueueBitAccountStorage} from "../../src/account/QueueBitAccountStorage.sol";
import {TypedPermits} from "../../src/lib/TypedPermits.sol";
import {AccountTestBase} from "./AccountTestBase.sol";
import {Permit2Mock, Auth3009Token, Permit2Spender} from "./mocks/TypedPermitMocks.sol";

/// Typed registrations beyond ERC-2612 (account audit follow-up): Permit2 `PermitSingle` / `PermitTransferFrom` and
/// EIP-3009. The C1 lesson applies to each: the digest is computed on chain from typed fields, the debit is the typed
/// amount, and the hash is honoured for its one consumer only. Every PoC below is a C1-style attack (a declared amount
/// unlike the real one, the wrong caller, a replay) and must fail. `TypedPermitsStrictTest` re-runs them in Strict.
contract TypedPermitsTest is AccountTestBase {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant BAD = 0xffffffff;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address internal attacker = makeAddr("attacker");
    Auth3009Token internal tok; // allowlisted at $1, 18 decimals; ERC-2612 + EIP-3009 + held by the account
    Permit2Mock internal p2;
    Permit2Spender internal spender; // session-bound (spender.execute)
    uint256 internal deadline;
    uint48 internal expiration;

    function setUp() public virtual override {
        super.setUp();
        tok = new Auth3009Token("tUSD");
        vm.etch(PERMIT2, address(new Permit2Mock()).code);
        p2 = Permit2Mock(PERMIT2);
        spender = new Permit2Spender();
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetToken, (address(tok), true, 18, 1 * USD)));
        _queueLoosen(
            abi.encodeCall(
                QueueBitAccountRoles.vaultSetSession,
                (address(spender), Permit2Spender.execute.selector, 100 * USD, uint48(vm.getBlockTimestamp() + 30 days))
            )
        );
        tok.mint(address(account), 90_000 ether);
        vm.prank(address(account)); // the vault's one-time Permit2 approval (a vault op in production)
        tok.approve(PERMIT2, type(uint256).max);
        _resetTimes();
    }

    /// Deadlines relative to now (queued loosenings warp the clock).
    function _resetTimes() internal {
        deadline = vm.getBlockTimestamp() + 1 hours;
        expiration = uint48(vm.getBlockTimestamp() + 7 days);
    }

    function _callFailed(bytes memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IQueueBitAccount.CallFailed.selector, 0, reason);
    }

    function _regSingle(uint160 amount, address who) internal view returns (IQueueBitAccount.Call memory) {
        return _selfCall(
            abi.encodeCall(
                QueueBitAccountImpl.registerPermit2,
                (address(tok), amount, expiration, who, deadline, Permit2Spender.execute.selector)
            )
        );
    }

    function _regTransfer(uint256 amount, address who, uint256 nonce)
        internal
        view
        returns (IQueueBitAccount.Call memory)
    {
        return _selfCall(
            abi.encodeCall(
                QueueBitAccountImpl.registerPermit2Transfer,
                (address(tok), amount, who, nonce, deadline, Permit2Spender.execute.selector)
            )
        );
    }

    function _reg3009(uint256 value, address to, bytes32 nonce, bool receiveAuth)
        internal
        view
        returns (IQueueBitAccount.Call memory)
    {
        return _selfCall(
            abi.encodeCall(
                QueueBitAccountImpl.registerTransferAuthorization,
                (address(tok), value, to, 0, deadline, nonce, receiveAuth)
            )
        );
    }

    function _single(uint160 amount, uint48 nonce) internal view returns (Permit2Mock.PermitSingle memory) {
        return Permit2Mock.PermitSingle(
            Permit2Mock.PermitDetails(address(tok), amount, expiration, nonce), address(spender), deadline
        );
    }

    function _xfer(uint256 amount, uint256 nonce) internal view returns (Permit2Mock.PermitTransferFrom memory) {
        return Permit2Mock.PermitTransferFrom(Permit2Mock.TokenPermissions(address(tok), amount), nonce, deadline);
    }

    // ------------------------------------------------------------------------------ canonical type hashes ------

    /// The library's constants equal the canonical Permit2 / EIP-3009 values (the Permit2 hex values are the ones
    /// `PermitHash.sol` publishes), and its digests equal what Permit2 (the transcribed mock) and the token compute.
    function test_typeHashes_matchCanonical() public view {
        assertEq(
            TypedPermits.PERMIT_DETAILS_TYPEHASH, 0x65626cad6cb96493bf6f5ebea28756c966f023ab9e8a83a7101849d5573b3678
        );
        assertEq(
            TypedPermits.PERMIT_SINGLE_TYPEHASH, 0xf3841cd1ff0085026a6327b620b67997ce40f282c88a8e905a7a5626e310f3d0
        );
        assertEq(
            TypedPermits.TOKEN_PERMISSIONS_TYPEHASH, 0x618358ac3db8dc274f0cd8829da7e234bd48cd73c4a740aede1adec9846d06a1
        );
        assertEq(
            TypedPermits.PERMIT_TRANSFER_FROM_TYPEHASH,
            0x939c21a48a8dbe3a9a2404a1d46691e4d39f6583d6ec6b35714604c986d80106
        );
        assertEq(TypedPermits.PERMIT_DETAILS_TYPEHASH, p2._PERMIT_DETAILS_TYPEHASH());
        assertEq(TypedPermits.PERMIT_SINGLE_TYPEHASH, p2._PERMIT_SINGLE_TYPEHASH());
        assertEq(TypedPermits.TOKEN_PERMISSIONS_TYPEHASH, p2._TOKEN_PERMISSIONS_TYPEHASH());
        assertEq(TypedPermits.PERMIT_TRANSFER_FROM_TYPEHASH, p2._PERMIT_TRANSFER_FROM_TYPEHASH());
        assertEq(TypedPermits.TRANSFER_WITH_AUTHORIZATION_TYPEHASH, tok.TRANSFER_WITH_AUTHORIZATION_TYPEHASH());
        assertEq(TypedPermits.RECEIVE_WITH_AUTHORIZATION_TYPEHASH, tok.RECEIVE_WITH_AUTHORIZATION_TYPEHASH());
        assertEq(TypedPermits.permit2DomainSeparator(), p2.DOMAIN_SEPARATOR());
        assertEq(
            TypedPermits.permitTransferFromDigest(address(tok), 5, address(spender), 7, deadline),
            p2.hashPermitTransferFrom(_xfer(5, 7), address(spender))
        );
    }

    // ------------------------------------------------------------------------------ Permit2 PermitSingle ------

    function test_permit2Single_bindsAmountSpenderAndPermit2() public {
        bytes32 digest = p2.hashPermitSingle(_single(40 ether, 0));
        vm.expectEmit(address(account));
        emit IQueueBitAccount.HashRegistered(digest, address(tok), 40 ether, uint48(deadline));
        _hot(40 * USD, _one(_regSingle(40 ether, address(spender))));
        assertEq(_bucketAvailable(), CAP - 40 * USD, "debited at the permit's amount");
        assertEq(account.registeredHashConsumer(digest), PERMIT2);

        // only Permit2 may consume it
        vm.prank(PERMIT2);
        assertEq(account.isValidSignature(digest, ""), MAGIC);
        vm.prank(address(tok));
        assertEq(account.isValidSignature(digest, ""), BAD, "the token is not the consumer");
        vm.prank(address(0));
        assertEq(account.isValidSignature(digest, ""), BAD, "nor eth_call");
        vm.prank(attacker);
        assertEq(account.isValidSignature(digest, ""), BAD);

        spender.permitAndPull(p2, address(account), _single(40 ether, 0), alice, 40 ether);
        assertEq(tok.balanceOf(alice), 40 ether);
    }

    /// C1: the hot key registers a small permit; the attacker submits Permit2 a large one (or a later expiration,
    /// or another spender): every variant is a different digest, never registered.
    function test_C1_permit2Single_declaredAmountUnlikeReal() public {
        _hot(1 * USD, _one(_regSingle(1 ether, address(spender))));
        Permit2Mock.PermitSingle memory big = _single(90_000 ether, 0);
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        p2.permit(address(account), big, "");
        Permit2Mock.PermitSingle memory later = _single(1 ether, 0);
        later.details.expiration = type(uint48).max;
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        p2.permit(address(account), later, "");
        Permit2Mock.PermitSingle memory other = _single(1 ether, 0);
        other.spender = attacker;
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        p2.permit(address(account), other, "");
        // the declared USD of the batch cannot under-state the typed amount either
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.DeclaredUsdExceeded.selector, 50 * USD, 1 * USD));
        _hot(1 * USD, _one(_regSingle(50 ether, address(spender))));
        (uint160 amt,,) = p2.allowance(address(account), address(tok), attacker);
        assertEq(amt, 0);
        assertEq(tok.balanceOf(attacker), 0);
    }

    /// Replay: the digest is bound to the Permit2 nonce read at registration; once used, Permit2 refuses it again.
    function test_permit2Single_replayRefused() public {
        _hot(10 * USD, _one(_regSingle(10 ether, address(spender))));
        spender.permitAndPull(p2, address(account), _single(10 ether, 0), alice, 10 ether);
        vm.expectRevert(Permit2Mock.InvalidNonce.selector);
        spender.permitAndPull(p2, address(account), _single(10 ether, 0), alice, 10 ether);
        // the next nonce needs (and debits) a new registration
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        spender.permitAndPull(p2, address(account), _single(10 ether, 1), alice, 10 ether);
        _hot(10 * USD, _one(_regSingle(10 ether, address(spender))));
        spender.permitAndPull(p2, address(account), _single(10 ether, 1), alice, 10 ether);
        assertEq(tok.balanceOf(alice), 20 ether);
        assertEq(_bucketAvailable(), CAP - 20 * USD);
    }

    function test_permit2Single_reverts() public {
        // not a self-call of an open hot batch
        vm.expectRevert(IQueueBitAccount.OnlySelf.selector);
        account.registerPermit2(address(tok), 1, expiration, address(spender), deadline, bytes4(0));
        vm.prank(address(account));
        vm.expectRevert(IQueueBitAccount.NotInHotBatch.selector);
        account.registerPermit2(address(tok), 1, expiration, address(spender), deadline, bytes4(0));
        // a spender that is neither allowlisted nor session-bound (Open mode does not widen spenders)
        vm.expectRevert(
            _callFailed(
                abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, attacker, Permit2Spender.execute.selector)
            )
        );
        _hot(1 * USD, _one(_regSingle(1 ether, attacker)));
        // the session must be the one named
        IQueueBitAccount.Call memory c = _selfCall(
            abi.encodeCall(
                QueueBitAccountImpl.registerPermit2,
                (address(tok), 1 ether, expiration, address(spender), deadline, bytes4(0xdeadbeef))
            )
        );
        vm.expectRevert(
            _callFailed(
                abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(spender), bytes4(0xdeadbeef))
            )
        );
        _hot(1 * USD, _one(c));
        // expiration: 0 ("this block"), past, or beyond MAX_REGISTERED_TTL
        uint48[3] memory bad = [uint48(0), uint48(vm.getBlockTimestamp()), uint48(vm.getBlockTimestamp() + 31 days)];
        for (uint256 i; i < 3; ++i) {
            expiration = bad[i];
            vm.expectRevert(_callFailed(abi.encodeWithSelector(IQueueBitAccount.BadExpiry.selector)));
            _hot(1 * USD, _one(_regSingle(1 ether, address(spender))));
        }
        expiration = uint48(vm.getBlockTimestamp() + 1 days);
        // past signature deadline
        deadline = vm.getBlockTimestamp();
        vm.expectRevert(_callFailed(abi.encodeWithSelector(IQueueBitAccount.BadExpiry.selector)));
        _hot(1 * USD, _one(_regSingle(1 ether, address(spender))));
        deadline = vm.getBlockTimestamp() + 1 hours;
        // an "infinite" allowance cannot be registered (its debit exceeds the per-tx bound)
        vm.expectRevert();
        _hot(type(uint256).max, _one(_regSingle(type(uint160).max, address(spender))));
        // unpriced token
        c = _selfCall(
            abi.encodeCall(
                QueueBitAccountImpl.registerPermit2, (attacker, 1, expiration, address(spender), deadline, bytes4(0))
            )
        );
        vm.expectRevert(_callFailed(abi.encodeWithSelector(IQueueBitAccount.TokenNotAllowed.selector, attacker)));
        _hot(1 * USD, _one(c));
        // a removed session no longer binds the spender
        vm.prank(vault);
        roles.vaultSetSession(address(spender), Permit2Spender.execute.selector, 0, 0);
        vm.expectRevert(
            _callFailed(
                abi.encodeWithSelector(
                    IQueueBitAccount.NotAllowed.selector, address(spender), Permit2Spender.execute.selector
                )
            )
        );
        _hot(1 * USD, _one(_regSingle(1 ether, address(spender))));
    }

    /// Security review (2026-11-06): the Permit2 variants without a registration (`PermitBatch`,
    /// `permitWitnessTransferFrom`) can never get a "yes" when Permit2 asks: not through the hot key's 7739
    /// material (Permit2 is a denied value verifier) and not through an opaque `registerHash` of their digest with
    /// a lying amount (C1: an opaque hash is never honoured for Permit2). Off-chain (`eth_call`) they still verify,
    /// which moves nothing.
    function test_permit2_batchAndWitness_neverHonoured() public {
        bytes32 ds = TypedPermits.permit2DomainSeparator();
        bytes32 details = keccak256(
            abi.encode(TypedPermits.PERMIT_DETAILS_TYPEHASH, address(tok), uint160(90_000 ether), expiration, uint48(0))
        );
        bytes32 batch = MessageHashUtils.toTypedDataHash(
            ds,
            keccak256(
                abi.encode(
                    keccak256(
                        "PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
                    ),
                    keccak256(abi.encodePacked(details)),
                    address(spender),
                    deadline
                )
            )
        );
        bytes32 witness = MessageHashUtils.toTypedDataHash(
            ds,
            keccak256(
                abi.encode(
                    keccak256(
                        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,bytes32 witness)TokenPermissions(address token,uint256 amount)"
                    ),
                    keccak256(abi.encode(TypedPermits.TOKEN_PERMISSIONS_TYPEHASH, address(tok), 90_000 ether)),
                    address(spender),
                    uint256(5),
                    deadline,
                    keccak256("order")
                )
            )
        );
        bytes32[2] memory digests = [batch, witness];
        for (uint256 i; i < 2; ++i) {
            bytes32 d = digests[i];
            bytes memory sig = _personalSign(d);
            vm.prank(address(0));
            assertEq(account.isValidSignature(d, sig), MAGIC, "the hot key's material verifies off chain");
            vm.prank(PERMIT2);
            assertEq(account.isValidSignature(d, sig), BAD, "never for Permit2");
            // C1 replay: an opaque registration of the digest at 1 wei of declared value
            _hot(
                1,
                _one(
                    _selfCall(abi.encodeCall(QueueBitAccountImpl.registerHash, (d, address(tok), 1, uint48(deadline))))
                )
            );
            vm.prank(PERMIT2);
            assertEq(account.isValidSignature(d, ""), BAD, "an opaque hash is never honoured for Permit2");
            vm.prank(PERMIT2);
            assertEq(account.isValidSignature(d, sig), BAD);
        }
        assertEq(tok.balanceOf(attacker), 0);
    }

    /// Cross-account replay: a `PermitSingle` digest carries no owner (Permit2 asks the owner it is given), so a
    /// second QueueBit account with the same (token, spender, nonce) has the same digest. Only the account that
    /// registered it answers for it.
    function test_permit2Single_crossAccountReplayRefused() public {
        address b = factory.createAccount(bytes32(uint256(2)), address(impl), _initData(_defaultCfg()));
        tok.mint(b, 90_000 ether);
        vm.prank(b);
        tok.approve(PERMIT2, type(uint256).max);
        bytes32 digest = p2.hashPermitSingle(_single(40 ether, 0));
        assertEq(
            TypedPermits.permitSingleDigest(b, address(tok), 40 ether, expiration, address(spender), deadline),
            digest,
            "same digest for both owners"
        );
        _hot(40 * USD, _one(_regSingle(40 ether, address(spender))));
        vm.prank(PERMIT2);
        assertEq(QueueBitAccountImpl(payable(b)).isValidSignature(digest, ""), BAD, "B never registered it");
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        spender.permitAndPull(p2, b, _single(40 ether, 0), attacker, 40 ether);
        assertEq(tok.balanceOf(b), 90_000 ether);
    }

    /// What a registration does and does not bind after the fact (threat model §3.1): a freeze blocks every
    /// unconsumed registration (the account answers nothing while frozen), but an allowance the spender already
    /// set at Permit2 is outside the account's reach: it survives the freeze and the session's removal until its
    /// expiration, at the debited amount. The vault revokes it at Permit2 (`approve(token, spender, 0, 0)` /
    /// `lockdown`), as it approved Permit2 on the token in the first place.
    function test_permit2Single_setAllowanceOutlivesFreezeAndSession() public {
        _hot(10 * USD, _one(_regSingle(10 ether, address(spender))));
        p2.permit(address(account), _single(10 ether, 0), ""); // the spender submits the permit (allowance set)
        _hot(10 * USD, _one(_regSingle(10 ether, address(spender)))); // a second one at nonce 1, not yet submitted
        vm.prank(guardian);
        roles.guardianFreeze();
        vm.prank(vault);
        roles.vaultSetSession(address(spender), Permit2Spender.execute.selector, 0, 0);

        // the unconsumed registration is dead while frozen
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        p2.permit(address(account), _single(10 ether, 1), "");
        // the set allowance is not: Permit2 does not consult the account
        vm.prank(address(spender));
        p2.transferFrom(address(account), alice, 10 ether, address(tok));
        assertEq(tok.balanceOf(alice), 10 ether);
        (uint160 left, uint48 exp,) = p2.allowance(address(account), address(tok), address(spender));
        assertEq(left, 0, "bounded by the debited amount");
        assertEq(exp, expiration);
        // after the vault unfreezes, the second registration (still unexpired, nonce 1) is consumable again; the
        // vault's revocation path is Permit2 itself (a vault op in production, like the approval in setUp)
        vm.prank(vault);
        roles.vaultUnfreeze();
        p2.permit(address(account), _single(10 ether, 1), "");
        (left,,) = p2.allowance(address(account), address(tok), address(spender));
        assertEq(left, 10 ether);
        vm.prank(address(account));
        p2.approve(address(tok), address(spender), 0, 0);
        vm.prank(address(spender));
        vm.expectRevert(abi.encodeWithSelector(Permit2Mock.AllowanceExpired.selector, 0));
        p2.transferFrom(address(account), alice, 10 ether, address(tok));
        assertEq(tok.balanceOf(alice), 10 ether, "nothing beyond what was debited and set");
    }

    function _personalSign(bytes32 hash) internal view returns (bytes memory) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("QueueBit"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("PersonalSign(bytes prefixed)"), hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotPk, MessageHashUtils.toTypedDataHash(ds, structHash));
        return abi.encodePacked(r, s, v);
    }

    /// An allowlisted target is a valid spender without a session.
    function test_permit2Single_allowlistedSpender() public {
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (alice, true)));
        _resetTimes();
        _hot(2 * USD, _one(_regSingle(2 ether, alice)));
        Permit2Mock.PermitSingle memory ps = _single(2 ether, 0);
        ps.spender = alice;
        p2.permit(address(account), ps, "");
        vm.prank(alice);
        p2.transferFrom(address(account), alice, 2 ether, address(tok));
        assertEq(tok.balanceOf(alice), 2 ether);
    }

    // ------------------------------------------------------------------------ Permit2 PermitTransferFrom ------

    function test_permit2Transfer_bindsSpenderAndNonce() public {
        uint256 nonce = 0x1234;
        bytes32 digest = p2.hashPermitTransferFrom(_xfer(30 ether, nonce), address(spender));
        _hot(30 * USD, _one(_regTransfer(30 ether, address(spender), nonce)));
        assertEq(account.registeredHashConsumer(digest), PERMIT2);
        assertEq(_bucketAvailable(), CAP - 30 * USD);

        // the wrong caller: the attacker calling Permit2 itself is hashed as the spender
        vm.prank(attacker);
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        p2.permitTransferFrom(
            _xfer(30 ether, nonce), Permit2Mock.SignatureTransferDetails(attacker, 30 ether), address(account), ""
        );
        // C1: a larger permitted amount is another digest
        vm.expectRevert(Permit2Mock.InvalidContractSignature.selector);
        spender.pullSigned(p2, address(account), _xfer(90_000 ether, nonce), attacker, 90_000 ether);

        spender.pullSigned(p2, address(account), _xfer(30 ether, nonce), alice, 30 ether);
        assertEq(tok.balanceOf(alice), 30 ether);
        // replay
        vm.expectRevert(Permit2Mock.InvalidNonce.selector);
        spender.pullSigned(p2, address(account), _xfer(30 ether, nonce), alice, 30 ether);
        // a spent nonce cannot be registered again
        vm.expectRevert(_callFailed(abi.encodeWithSelector(IQueueBitAccount.NonceUsed.selector)));
        _hot(30 * USD, _one(_regTransfer(30 ether, address(spender), nonce)));
        assertEq(tok.balanceOf(attacker), 0);
    }

    function test_permit2Transfer_spenderRule() public {
        vm.expectRevert(
            _callFailed(
                abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, attacker, Permit2Spender.execute.selector)
            )
        );
        _hot(1 * USD, _one(_regTransfer(1 ether, attacker, 1)));
    }

    // ------------------------------------------------------------------------------------------ EIP-3009 ------

    function test_3009_transfer_bindsValueRecipientAndToken() public {
        bytes32 nonce = keccak256("n1");
        bytes32 digest = tok.authDigest(false, address(account), alice, 25 ether, 0, deadline, nonce);
        _hot(25 * USD, _one(_reg3009(25 ether, alice, nonce, false)));
        assertEq(account.registeredHashConsumer(digest), address(tok));
        assertEq(_bucketAvailable(), CAP - 25 * USD);
        vm.prank(PERMIT2);
        assertEq(account.isValidSignature(digest, ""), BAD, "Permit2 is not the consumer");
        vm.prank(address(0));
        assertEq(account.isValidSignature(digest, ""), BAD);

        // C1: another value or recipient is another digest
        vm.expectRevert(bytes("bad sig"));
        tok.transferWithAuthorization(address(account), alice, 90_000 ether, 0, deadline, nonce, "");
        vm.expectRevert(bytes("bad sig"));
        tok.transferWithAuthorization(address(account), attacker, 25 ether, 0, deadline, nonce, "");
        // a transfer digest is not a receive digest
        vm.prank(alice);
        vm.expectRevert(bytes("bad sig"));
        tok.receiveWithAuthorization(address(account), alice, 25 ether, 0, deadline, nonce, "");

        vm.prank(attacker); // anyone may submit a transferWithAuthorization: the money still goes to alice
        tok.transferWithAuthorization(address(account), alice, 25 ether, 0, deadline, nonce, "");
        assertEq(tok.balanceOf(alice), 25 ether);
        // replay
        vm.expectRevert(bytes("used"));
        tok.transferWithAuthorization(address(account), alice, 25 ether, 0, deadline, nonce, "");
        vm.expectRevert(_callFailed(abi.encodeWithSelector(IQueueBitAccount.NonceUsed.selector)));
        _hot(25 * USD, _one(_reg3009(25 ether, alice, nonce, false)));
    }

    function test_3009_receive() public virtual {
        bytes32 nonce = keccak256("r1");
        _hot(5 * USD, _one(_reg3009(5 ether, alice, nonce, true)));
        vm.expectRevert(bytes("caller must be the payee"));
        tok.receiveWithAuthorization(address(account), alice, 5 ether, 0, deadline, nonce, "");
        vm.prank(alice);
        tok.receiveWithAuthorization(address(account), alice, 5 ether, 0, deadline, nonce, "");
        assertEq(tok.balanceOf(alice), 5 ether);
    }

    function test_3009_recipientRule() public {
        // never the token itself, the account, or (Open) an allowlisted token / the tank
        vm.expectRevert(_callFailed(abi.encodeWithSelector(IQueueBitAccount.ForbiddenRecipient.selector, address(tok))));
        _hot(1 * USD, _one(_reg3009(1 ether, address(tok), keccak256("x"), false)));
        vm.expectRevert(
            _callFailed(abi.encodeWithSelector(IQueueBitAccount.ForbiddenRecipient.selector, address(account)))
        );
        _hot(1 * USD, _one(_reg3009(1 ether, address(account), keccak256("x"), false)));
        vm.expectRevert(
            _callFailed(
                abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, address(0), IERC20.transfer.selector)
            )
        );
        _hot(1 * USD, _one(_reg3009(1 ether, address(0), keccak256("x"), false)));
        // validAfter >= validBefore
        IQueueBitAccount.Call memory c = _selfCall(
            abi.encodeCall(
                QueueBitAccountImpl.registerTransferAuthorization,
                (address(tok), 1 ether, alice, deadline, deadline, keccak256("x"), false)
            )
        );
        vm.expectRevert(_callFailed(abi.encodeWithSelector(IQueueBitAccount.BadExpiry.selector)));
        _hot(1 * USD, _one(c));
    }

    /// Open mode: an arbitrary recipient is allowed, exactly as for a hot `transfer`.
    function test_3009_openModeArbitraryRecipient() public virtual {
        _hot(1 * USD, _one(_reg3009(1 ether, stranger, keccak256("o"), false)));
        tok.transferWithAuthorization(address(account), stranger, 1 ether, 0, deadline, keccak256("o"), "");
        assertEq(tok.balanceOf(stranger), 1 ether);
    }

    // ------------------------------------------------------------------------------------------- I-2 ------

    /// The typed registrations write no slot VERIFY reads (slots 0-2 of the layout).
    function test_I2_typedRegistrationsWriteNoVerifySlot() public {
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](3);
        c[0] = _regSingle(1 ether, address(spender));
        c[1] = _regTransfer(1 ether, address(spender), 9);
        c[2] = _reg3009(1 ether, alice, keccak256("i2"), false);
        vm.record();
        _hot(3 * USD, c);
        (, bytes32[] memory w) = vm.accesses(address(account));
        uint256 base = uint256(QueueBitAccountStorage.SLOT);
        for (uint256 i; i < w.length; ++i) {
            uint256 s = uint256(w[i]);
            assertTrue(s != base && s != base + 1 && s != base + 2, "wrote a VERIFY-read slot");
        }
    }
}

/// The same PoCs with the recipient allowlist (`RecipientMode.Strict`).
contract TypedPermitsStrictTest is TypedPermitsTest {
    function setUp() public override {
        super.setUp();
        _strict();
        _queueLoosen(abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (alice, true)));
        _resetTimes();
    }

    function test_3009_openModeArbitraryRecipient() public override {
        vm.expectRevert(
            _callFailed(
                abi.encodeWithSelector(IQueueBitAccount.NotAllowed.selector, stranger, IERC20.transfer.selector)
            )
        );
        _hot(1 * USD, _one(_reg3009(1 ether, stranger, keccak256("o"), false)));
    }
}

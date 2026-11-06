// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TxSim} from "./TxSim.sol";
import {LeanPoolMerkle as MerkleLib} from "../../src/leanpool/LeanPoolMerkle.sol";
import {DepsRegistry} from "../../src/leanpool/DepsRegistry.sol";
import {LeanAccount} from "../../src/account/LeanAccount.sol";
import {LeanAccountFactory} from "../../src/account/LeanAccountFactory.sol";
import {KeystoreValidator, IRingRegistry} from "../../src/account/KeystoreValidator.sol";
import {SpendingLimitHook, ISessionContext} from "../../src/account/SpendingLimitHook.sol";
import {GuardianRecovery} from "../../src/account/GuardianRecovery.sol";
import {WebAuthn} from "../../src/account/WebAuthn.sol";
import {FrameHelperHub} from "../../src/account/FrameOps.sol";
import {ModuleType, ExecMode, Execution} from "../../src/account/interfaces.sol";
import {LegacyAccount, LegacyERC1967Proxy, TestToken} from "./fixtures/LegacyAccount.sol";

contract Sink {
    uint256 public hits;

    receive() external payable {
        hits++;
    }

    function poke() external payable {
        hits++;
    }
}

contract LeanAccountTest is TxSim {
    event Approved(uint256 scope);
    event Upgraded(address indexed implementation);

    uint8 constant PQ = 1;
    uint8 constant PASSKEY = 2;
    uint8 constant P256 = 3;
    uint8 constant ECDSA = 4;
    uint8 constant ADMIN = 1;
    uint8 constant SPEND = 2;
    uint8 constant SESSION = 4;
    uint8 constant ADMIN_SPEND = 3;

    DepsRegistry reg;
    KeystoreValidator ks;
    LeanAccount impl;
    FrameHelperHub hub;
    LeanAccountFactory factory;
    SpendingLimitHook hook;
    GuardianRecovery recovery;
    Sink sink;

    address aggregator = makeAddr("aggregator");
    address g1 = makeAddr("guardian1");
    address g2 = makeAddr("guardian2");
    address g3 = makeAddr("guardian3");
    bytes32 vkA = keccak256("vk A");
    bytes32 vkB = keccak256("vk B");
    bytes32 vkC = keccak256("vk C");
    bytes32 sh = keccak256("the tx SIG_HASH");
    address ecdsaSigner = makeAddr("classical key");
    bytes lastVerify;
    uint256 saltN;

    function setUp() public {
        reg = new DepsRegistry(0.01 ether);
        hub = new FrameHelperHub();
        ks = new KeystoreValidator(IRingRegistry(address(reg)), hub);
        impl = new LeanAccount(hub);
        factory = new LeanAccountFactory(address(impl));
        hook = new SpendingLimitHook(ISessionContext(address(ks)));
        recovery = new GuardianRecovery(address(ks), KeystoreValidator.resetKeys.selector);
        sink = new Sink();
        wireTxSim(address(hub));
        vm.deal(aggregator, 1 ether);
        vm.prank(aggregator);
        reg.bond{value: 0.01 ether}();
    }

    // ------------------------------------------------------------------------------------------ builders ----------

    function _key(uint8 kind, bytes32 a, bytes32 b, uint8 weight, uint8 roles)
        internal
        pure
        returns (KeystoreValidator.KeyInit memory k)
    {
        k.kind = kind;
        k.a = a;
        k.b = b;
        k.weight = weight;
        k.roles = roles;
    }

    function _policy(uint16 admin, uint16 spend, bool requirePQ)
        internal
        view
        returns (KeystoreValidator.Policy memory)
    {
        return KeystoreValidator.Policy(admin, spend, requirePQ, aggregator);
    }

    function _account(KeystoreValidator.KeyInit[] memory keys, KeystoreValidator.Policy memory p)
        internal
        returns (LeanAccount a)
    {
        address[] memory gs = new address[](3);
        (gs[0], gs[1], gs[2]) = (g1, g2, g3);
        address[] memory execs = new address[](1);
        execs[0] = address(recovery);
        bytes[] memory inits = new bytes[](1);
        inits[0] = abi.encode(gs, uint8(2), uint32(1 days));
        LeanAccountFactory.Init memory init =
            LeanAccountFactory.Init(address(ks), abi.encode(p, keys), address(hook), "", execs, inits);
        a = LeanAccount(payable(factory.createAccount{value: 1 ether}(bytes32(++saltN), init)));
    }

    function _one(KeystoreValidator.KeyInit memory k) internal pure returns (KeystoreValidator.KeyInit[] memory l) {
        l = new KeystoreValidator.KeyInit[](1);
        l[0] = k;
    }

    function _triple(bytes32 vk) internal pure returns (bytes memory) {
        return abi.encodePacked(uint256(0x10), bytes32(0), vk);
    }

    function _leaf(bytes32 vk) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(uint256(0x10), sh, vk));
    }

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(
            LeanAccount.execute,
            (
                ExecMode.encode(ExecMode.CALLTYPE_SINGLE, ExecMode.EXECTYPE_DEFAULT),
                abi.encodePacked(target, value, data)
            )
        );
    }

    /// [VERIFY(account.verify(ks, envelope)), SENDER(account.execute(...))]; entry 0 = witness when PQ triples given.
    function _tx(LeanAccount a, bytes memory triples, uint256[] memory passkeys, bytes memory senderCall) internal {
        txm.reset(address(a), sh);
        lastVerify = abi.encodeCall(
            LeanAccount.verify, (abi.encode(address(ks), abi.encode(ks.LEANPOOL_DEPS(), triples, passkeys)))
        );
        txm.addFrame(1, address(0), 0, lastVerify);
        if (senderCall.length > 0) txm.addFrame(2, address(0), 0, senderCall);
    }

    /// Posts a root over the given PQ leaves for the account and adds the witness as entry 0.
    function _witness(LeanAccount a, bytes32[] memory leaves, bytes32[][] memory proofs, bytes32 root) internal {
        address[] memory ws = new address[](1);
        ws[0] = address(a);
        vm.prank(aggregator);
        uint8 ring = reg.postRoot(root, uint16(leaves.length), ws);
        txm.addSig(0, address(0), 0, abi.encode(root, ring, proofs));
    }

    /// The VERIFY frame (index 0; TxModel.reset sets it) calls the account.
    function _verify(LeanAccount a) internal returns (bool ok, bytes memory err) {
        (ok, err) = address(a).call(lastVerify);
    }

    function _none() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    /// One PQ signer: the root is its leaf.
    function _pq1(LeanAccount a, bytes32 vk, bytes memory senderCall) internal {
        _tx(a, _triple(vk), _none(), senderCall);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(vk);
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);
        _witness(a, leaves, proofs, leaves[0]);
    }

    function _pqAccount() internal returns (LeanAccount) {
        return _account(_one(_key(PQ, vkA, 0, 1, ADMIN_SPEND)), _policy(1, 1, true));
    }

    // ------------------------------------------------------------------------------------------ ERC-8286 flow ----

    function test_pqSignerApprovesExecutionAndPayment() public {
        LeanAccount a = _pqAccount();
        _pq1(a, vkA, _single(address(sink), 0.1 ether, ""));
        vm.expectEmit(address(a));
        emit Approved(3);
        (bool ok,) = _verify(a);
        assertTrue(ok);
    }

    function test_verifyOnlyRunsInAVerifyFrame() public {
        LeanAccount a = _pqAccount();
        _pq1(a, vkA, _single(address(sink), 0, ""));
        txm.setCurrentFrame(1); // the SENDER frame
        (bool ok, bytes memory err) = address(a).call(lastVerify);
        assertFalse(ok);
        assertEq(bytes4(err), LeanAccount.NotVerifyFrame.selector);
    }

    function test_executionNeedsEverySenderFrameToTargetTheAccount() public {
        LeanAccount a = _pqAccount();
        _pq1(a, vkA, "");
        txm.addFrame(2, address(sink), 1, ""); // a SENDER frame straight to another contract
        // The keystore refuses the tx (a SENDER frame not through execute) -> nothing to approve.
        (bool ok, bytes memory err) = _verify(a);
        assertFalse(ok);
        assertEq(bytes4(err), LeanAccount.ValidationFailed.selector);
    }

    function test_allowedScopeMasksTheResult() public {
        LeanAccount a = _pqAccount();
        _pq1(a, vkA, _single(address(sink), 0, ""));
        txm.setAllowedScope(0, 1); // the frame only allows PAYMENT
        vm.expectEmit(address(a));
        emit Approved(1);
        (bool ok,) = _verify(a);
        assertTrue(ok);
    }

    function test_uninstalledValidatorIsRefused() public {
        LeanAccount a = _pqAccount();
        _pq1(a, vkA, _single(address(sink), 0, ""));
        lastVerify = abi.encodeCall(LeanAccount.verify, (abi.encode(makeAddr("rogue"), bytes(""))));
        txm.setCurrentFrame(0);
        (bool ok, bytes memory err) = address(a).call(lastVerify);
        assertFalse(ok);
        assertEq(bytes4(err), LeanAccount.ValidatorNotInstalled.selector);
    }

    // ------------------------------------------------------------------------------------------ PQ multisig ------

    function test_pqMultisigTwoOfThree() public {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](3);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN_SPEND);
        keys[1] = _key(PQ, vkB, 0, 1, ADMIN_SPEND);
        keys[2] = _key(PQ, vkC, 0, 1, ADMIN_SPEND);
        LeanAccount a = _account(keys, _policy(2, 2, true));

        // A and C sign: two triples, two proofs under one root.
        _tx(a, abi.encodePacked(_triple(vkA), _triple(vkC)), _none(), _single(address(sink), 0.2 ether, ""));
        bytes32[] memory leaves = new bytes32[](2);
        (leaves[0], leaves[1]) = (_leaf(vkA), _leaf(vkC));
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = new bytes32[](1);
        proofs[0][0] = leaves[1];
        proofs[1] = new bytes32[](1);
        proofs[1][0] = leaves[0];
        _witness(a, leaves, proofs, MerkleLib.hashPair(leaves[0], leaves[1]));
        vm.expectEmit(address(a));
        emit Approved(3);
        (bool ok,) = _verify(a);
        assertTrue(ok);
    }

    function test_pqMultisigOneOfThreeIsNotEnough() public {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](3);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN_SPEND);
        keys[1] = _key(PQ, vkB, 0, 1, ADMIN_SPEND);
        keys[2] = _key(PQ, vkC, 0, 1, ADMIN_SPEND);
        LeanAccount a = _account(keys, _policy(2, 2, true));
        _pq1(a, vkA, _single(address(sink), 0, ""));
        (bool ok, bytes memory err) = _verify(a);
        assertFalse(ok);
        assertEq(bytes4(err), LeanAccount.ValidationFailed.selector);
    }

    function test_pqSameKeyTwiceCountsOnce() public {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](2);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN_SPEND);
        keys[1] = _key(PQ, vkB, 0, 1, ADMIN_SPEND);
        LeanAccount a = _account(keys, _policy(2, 2, true));
        _tx(a, abi.encodePacked(_triple(vkA), _triple(vkA)), _none(), _single(address(sink), 0, ""));
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(vkA);
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = new bytes32[](0);
        proofs[1] = new bytes32[](0);
        _witness(a, leaves, proofs, leaves[0]);
        (bool ok,) = _verify(a);
        assertFalse(ok);
    }

    function test_pqRefusals() public {
        LeanAccount a = _pqAccount();
        // a leaf for another SIG_HASH
        _pq1(a, vkA, _single(address(sink), 0, ""));
        txm.reset(address(a), keccak256("another tx"));
        txm.addFrame(1, address(0), 0, lastVerify);
        txm.addFrame(2, address(0), 0, _single(address(sink), 0, ""));
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);
        txm.addSig(0, address(0), 0, abi.encode(_leaf(vkA), uint8(0), proofs));
        (bool ok, bytes memory err) = _verify(a);
        assertFalse(ok);
        assertEq(bytes4(err), KeystoreValidator.NotIncluded.selector);

        // a key the account does not hold
        _pq1(a, vkB, _single(address(sink), 0, ""));
        (ok, err) = _verify(a);
        assertFalse(ok);
        assertEq(bytes4(err), KeystoreValidator.UnknownKey.selector);

        // a root posted by a stranger for this account (a fresh account: its ring holds only the stranger's root)
        a = _pqAccount();
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        reg.bond{value: 0.01 ether}();
        _tx(a, _triple(vkA), _none(), _single(address(sink), 0, ""));
        address[] memory ws = new address[](1);
        ws[0] = address(a);
        vm.prank(stranger);
        uint8 ring = reg.postRoot(_leaf(vkA), 1, ws);
        txm.addSig(0, address(0), 0, abi.encode(_leaf(vkA), ring, proofs));
        (ok, err) = _verify(a);
        assertFalse(ok);
        assertEq(bytes4(err), KeystoreValidator.BadWitness.selector);
    }

    // ------------------------------------------------------------------------------------------ other key kinds --

    function test_ecdsaAndP256EntriesAreReadThroughSigparam() public {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](3);
        keys[0] = _key(PQ, vkA, 0, 2, ADMIN_SPEND);
        keys[1] = _key(ECDSA, bytes32(uint256(uint160(ecdsaSigner))), 0, 1, SPEND);
        address p256Signer = makeAddr("p256 device key");
        keys[2] = _key(P256, bytes32(uint256(uint160(p256Signer))), 0, 1, SPEND);
        LeanAccount a = _account(keys, _policy(2, 2, true));

        _tx(a, "", _none(), _single(address(sink), 0.01 ether, ""));
        txm.addSig(1, ecdsaSigner, 0, "");
        (bool ok,) = _verify(a);
        assertFalse(ok); // weight 1 < 2

        txm.addSig(2, p256Signer, 0, "");
        vm.expectEmit(address(a));
        emit Approved(3);
        (ok,) = _verify(a);
        assertTrue(ok); // 1 + 1

        // an entry over another message does not count
        _tx(a, "", _none(), _single(address(sink), 0, ""));
        txm.addSig(1, ecdsaSigner, keccak256("other"), "");
        txm.addSig(2, p256Signer, 0, "");
        (ok,) = _verify(a);
        assertFalse(ok);
    }

    function test_passkeyWebAuthn() public {
        string memory json = vm.readFile("test/account/fixtures/webauthn-vector.json");
        bytes32 x = vm.parseJsonBytes32(json, ".x");
        bytes32 y = vm.parseJsonBytes32(json, ".y");
        sh = vm.parseJsonBytes32(json, ".challenge");
        WebAuthn.Assertion memory w = WebAuthn.Assertion(
            vm.parseJsonBytes(json, ".authenticatorData"),
            vm.parseJsonString(json, ".clientDataJSON"),
            vm.parseJsonUint(json, ".challengeIndex"),
            vm.parseJsonUint(json, ".typeIndex"),
            uint256(vm.parseJsonBytes32(json, ".r")),
            uint256(vm.parseJsonBytes32(json, ".s"))
        );

        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](2);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN);
        keys[1] = _key(PASSKEY, x, y, 1, SPEND);
        LeanAccount a = _account(keys, _policy(1, 1, true));
        bytes32 pid = ks.keyIdOf(PASSKEY, x, y);
        uint256[] memory entries = new uint256[](1);
        entries[0] = 1;

        _tx(a, "", entries, _single(address(sink), 0.01 ether, ""));
        txm.addSig(0, address(0), 0, ""); // entry 0 unused (no PQ)
        txm.addSig(0, address(0), 0, abi.encode(pid, w));
        vm.expectEmit(address(a));
        emit Approved(3);
        (bool ok,) = _verify(a);
        assertTrue(ok);

        // a passkey cannot do admin work on a requirePQ account
        _tx(a, "", entries, _single(address(ks), 0, abi.encodeCall(KeystoreValidator.removeKey, (pid))));
        txm.addSig(0, address(0), 0, "");
        txm.addSig(0, address(0), 0, abi.encode(pid, w));
        (ok,) = _verify(a);
        assertFalse(ok);

        // tampered: user-present flag cleared
        WebAuthn.Assertion memory bad = w;
        bytes memory ad = bytes.concat(w.authenticatorData);
        ad[32] = 0x00;
        bad.authenticatorData = ad;
        _tx(a, "", entries, _single(address(sink), 0, ""));
        txm.addSig(0, address(0), 0, "");
        txm.addSig(0, address(0), 0, abi.encode(pid, bad));
        bytes memory err;
        (ok, err) = _verify(a);
        assertFalse(ok);
        assertEq(bytes4(err), KeystoreValidator.BadPasskey.selector);

        // signed for another tx
        sh = keccak256("another tx");
        _tx(a, "", entries, _single(address(sink), 0, ""));
        txm.addSig(0, address(0), 0, "");
        txm.addSig(0, address(0), 0, abi.encode(pid, w));
        (ok, err) = _verify(a);
        assertFalse(ok);
        assertEq(bytes4(err), KeystoreValidator.BadPasskey.selector);
    }

    /// The real EIP-7951 precompile (Foundry, evm_version osaka) accepts the vector and rejects a changed digest.
    function test_p256VerifyPrecompileIsReal() public view {
        string memory json = vm.readFile("test/account/fixtures/webauthn-vector.json");
        bytes32 digest = sha256(
            abi.encodePacked(
                vm.parseJsonBytes(json, ".authenticatorData"),
                sha256(bytes(vm.parseJsonString(json, ".clientDataJSON")))
            )
        );
        bytes memory input = abi.encode(
            digest,
            vm.parseJsonBytes32(json, ".r"),
            vm.parseJsonBytes32(json, ".s"),
            vm.parseJsonBytes32(json, ".x"),
            vm.parseJsonBytes32(json, ".y")
        );
        (bool ok, bytes memory out) = address(0x100).staticcall(input);
        assertTrue(ok);
        assertEq(abi.decode(out, (uint256)), 1);
        input[0] = bytes1(uint8(input[0]) ^ 1);
        (, out) = address(0x100).staticcall(input);
        assertEq(out.length, 0);
    }

    // ------------------------------------------------------------------------------------------ admin policy -----

    function test_adminActionNeedsAPostQuantumAdmin() public {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](2);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN_SPEND);
        keys[1] = _key(ECDSA, bytes32(uint256(uint160(ecdsaSigner))), 0, 1, ADMIN_SPEND);
        LeanAccount a = _account(keys, _policy(1, 1, true));
        bytes memory addKey =
            _single(address(ks), 0, abi.encodeCall(KeystoreValidator.addKey, (_key(PQ, vkB, 0, 1, ADMIN_SPEND))));

        _tx(a, "", _none(), addKey);
        txm.addSig(1, ecdsaSigner, 0, "");
        (bool ok,) = _verify(a);
        assertFalse(ok); // a classical admin key alone cannot change the account

        _pq1(a, vkA, addKey);
        (ok,) = _verify(a);
        assertTrue(ok);

        // spending with the classical key is fine (spendThreshold 1)
        _tx(a, "", _none(), _single(address(sink), 0.01 ether, ""));
        txm.addSig(1, ecdsaSigner, 0, "");
        (ok,) = _verify(a);
        assertTrue(ok);
    }

    function test_callsToModulesAndTheAccountAreAdmin() public {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](2);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN);
        keys[1] = _key(ECDSA, bytes32(uint256(uint160(ecdsaSigner))), 0, 1, SPEND);
        LeanAccount a = _account(keys, _policy(1, 1, true));
        address[3] memory targets = [address(a), address(hook), address(recovery)];
        for (uint256 i; i < 3; ++i) {
            _tx(a, "", _none(), _single(targets[i], 0, ""));
            txm.addSig(1, ecdsaSigner, 0, "");
            (bool ok,) = _verify(a);
            assertFalse(ok);
        }
    }

    // ------------------------------------------------------------------------------------------ sessions --------

    function _sessionAccount() internal returns (LeanAccount a, address sessionSigner, bytes32 sid) {
        sessionSigner = makeAddr("session key");
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](2);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN_SPEND);
        keys[1] = _key(ECDSA, bytes32(uint256(uint160(sessionSigner))), 0, 1, SESSION);
        keys[1].validUntil = uint48(block.timestamp + 7 days);
        keys[1].perTxCap = 0.05 ether;
        keys[1].sessionTargets = new address[](1);
        keys[1].sessionTargets[0] = address(sink);
        a = _account(keys, _policy(1, 1, true));
        sid = ks.keyIdOf(ECDSA, bytes32(uint256(uint160(sessionSigner))), 0);
    }

    function test_sessionKeyWithinItsScope() public {
        (LeanAccount a, address s,) = _sessionAccount();
        _tx(a, "", _none(), _single(address(sink), 0.05 ether, ""));
        txm.addSig(1, s, 0, "");
        (bool ok,) = _verify(a);
        assertTrue(ok);

        _tx(a, "", _none(), _single(address(sink), 0.06 ether, "")); // over the per-tx cap
        txm.addSig(1, s, 0, "");
        (ok,) = _verify(a);
        assertFalse(ok);

        _tx(a, "", _none(), _single(makeAddr("elsewhere"), 0.01 ether, "")); // not allowlisted
        txm.addSig(1, s, 0, "");
        (ok,) = _verify(a);
        assertFalse(ok);

        _tx(a, "", _none(), _single(address(ks), 0, abi.encodeCall(KeystoreValidator.removeKey, (bytes32(0))))); // admin
        txm.addSig(1, s, 0, "");
        (ok,) = _verify(a);
        assertFalse(ok);
    }

    /// ERC-7562 bans TIMESTAMP in validation, so VERIFY never reads the clock: an expired key still passes VERIFY and
    /// the transaction is stopped in execution, where the hook re-runs the keystore's decision with the clock.
    function test_anExpiredSessionKeyIsStoppedInExecution() public {
        (LeanAccount a, address s,) = _sessionAccount();
        bytes memory pay = _single(address(sink), 0.01 ether, "");
        vm.warp(block.timestamp + 8 days); // past validUntil
        _tx(a, "", _none(), pay);
        txm.addSig(1, s, 0, "");
        (bool ok,) = _verify(a);
        assertTrue(ok, "VERIFY does not read the clock");

        txm.setCurrentFrame(1);
        (bool allowed,,) = ks.executionContext(address(a));
        assertFalse(allowed);
        vm.prank(address(a));
        (ok,) = address(a).call(pay);
        assertFalse(ok, "the hook stops it");
        assertEq(sink.hits(), 0);
    }

    function test_anUnexpiredSessionKeyRunsInExecution() public {
        (LeanAccount a, address s,) = _sessionAccount();
        bytes memory pay = _single(address(sink), 0.01 ether, "");
        _tx(a, "", _none(), pay);
        txm.addSig(1, s, 0, "");
        txm.setCurrentFrame(1);
        (bool allowed, bool full,) = ks.executionContext(address(a));
        assertTrue(allowed);
        assertFalse(full);
        vm.prank(address(a));
        (bool ok,) = address(a).call(pay);
        assertTrue(ok);
    }

    function test_anExpiredAdminKeyIsStoppedInExecution() public {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](2);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN_SPEND);
        keys[1] = _key(PQ, vkB, 0, 1, ADMIN_SPEND);
        keys[1].validUntil = uint48(block.timestamp + 1 days);
        LeanAccount a = _account(keys, _policy(1, 1, true));
        bytes memory pay = _single(address(sink), 0.01 ether, "");
        vm.warp(block.timestamp + 2 days);
        _pq1(a, vkB, pay);
        (bool ok,) = _verify(a);
        assertTrue(ok);
        txm.setCurrentFrame(1);
        vm.prank(address(a));
        (ok,) = address(a).call(pay);
        assertFalse(ok);
    }

    function test_dailyCapIsEnforcedByTheHook() public {
        (LeanAccount a, address s, bytes32 sid) = _sessionAccount();
        vm.prank(address(a));
        hook.setDailyCap(sid, 0.08 ether);

        bytes memory pay = _single(address(sink), 0.05 ether, "");
        _tx(a, "", _none(), pay);
        txm.addSig(1, s, 0, "");
        txm.setCurrentFrame(1);
        vm.prank(address(a)); // the SENDER frame: caller = tx.sender
        (bool ok,) = address(a).call(pay);
        assertTrue(ok);
        assertEq(hook.limitOf(address(a), sid).spent, 0.05 ether);

        vm.prank(address(a));
        (ok,) = address(a).call(pay); // 0.10 > 0.08 today
        assertFalse(ok);

        vm.warp(block.timestamp + 1 days);
        vm.prank(address(a));
        (ok,) = address(a).call(pay);
        assertTrue(ok);
        assertEq(sink.hits(), 2);
    }

    function test_aFullQuorumIsNotLimitedByTheHook() public {
        (LeanAccount a,, bytes32 sid) = _sessionAccount();
        vm.prank(address(a));
        hook.setDailyCap(sid, 0.01 ether);
        bytes memory pay = _single(address(sink), 0.5 ether, "");
        _pq1(a, vkA, pay);
        txm.setCurrentFrame(1);
        vm.prank(address(a));
        (bool ok,) = address(a).call(pay);
        assertTrue(ok);
    }

    // ------------------------------------------------------------------------------------------ recovery --------

    function test_guardianRecoveryAfterTheDelay() public {
        LeanAccount a = _pqAccount();
        KeystoreValidator.KeyInit[] memory fresh = _one(_key(PQ, vkC, 0, 1, ADMIN_SPEND));
        bytes memory resetCall = abi.encodeCall(KeystoreValidator.resetKeys, (_policy(1, 1, true), fresh));

        vm.prank(g1);
        recovery.approve(address(a), resetCall);
        vm.expectRevert(GuardianRecovery.NotReady.selector);
        recovery.execute(address(a), resetCall);
        vm.prank(g3);
        recovery.approve(address(a), resetCall);
        vm.expectRevert(GuardianRecovery.NotReady.selector);
        recovery.execute(address(a), resetCall); // 2 of 3, but the delay is running

        vm.warp(block.timestamp + 1 days);
        recovery.execute(address(a), resetCall);
        assertEq(ks.getKey(address(a), ks.keyIdOf(PQ, vkA, 0)).kind, 0);
        assertEq(ks.getKey(address(a), ks.keyIdOf(PQ, vkC, 0)).kind, PQ);
        // Replaying it is impossible: the recovery nonce moved, so the same call is a new, unapproved proposal.
        vm.expectRevert(GuardianRecovery.NotReady.selector);
        recovery.execute(address(a), resetCall);
    }

    function test_theAccountCancelsARecovery() public {
        LeanAccount a = _pqAccount();
        bytes memory resetCall =
            abi.encodeCall(KeystoreValidator.resetKeys, (_policy(1, 1, true), _one(_key(PQ, vkC, 0, 1, ADMIN_SPEND))));
        vm.prank(g1);
        recovery.approve(address(a), resetCall);
        vm.prank(g2);
        recovery.approve(address(a), resetCall);
        bytes32 id = recovery.proposalId(address(a), resetCall);
        vm.prank(address(a));
        recovery.cancel(id);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(GuardianRecovery.AlreadyDone.selector);
        recovery.execute(address(a), resetCall);
    }

    /// Bug fix: uninstalling the executor used to leave every old guardian a guardian of the reinstalled module.
    function test_reinstallingRecoveryDropsTheOldGuardians() public {
        LeanAccount a = _pqAccount(); // guardians g1, g2, g3
        address g4 = makeAddr("guardian4");
        vm.startPrank(address(a));
        a.uninstallModule(ModuleType.EXECUTOR, address(recovery), "");
        address[] memory gs = new address[](1);
        gs[0] = g4;
        a.installModule(ModuleType.EXECUTOR, address(recovery), abi.encode(gs, uint8(1), uint32(1 days)));
        vm.stopPrank();

        assertFalse(recovery.isGuardian(g1, address(a)));
        assertTrue(recovery.isGuardian(g4, address(a)));
        (,, uint8 count,,,) = recovery.setups(address(a));
        assertEq(count, 1);
        bytes memory resetCall =
            abi.encodeCall(KeystoreValidator.resetKeys, (_policy(1, 1, true), _one(_key(PQ, vkC, 0, 1, ADMIN_SPEND))));
        vm.prank(g1);
        vm.expectRevert(GuardianRecovery.NotGuardian.selector);
        recovery.approve(address(a), resetCall);
        vm.prank(g4);
        recovery.approve(address(a), resetCall);
    }

    /// Every install starts with no live proposal: approvals collected under an earlier install cannot complete.
    function test_proposalsFromAnEarlierInstallDieWithIt() public {
        LeanAccount a = _pqAccount();
        bytes memory resetCall =
            abi.encodeCall(KeystoreValidator.resetKeys, (_policy(1, 1, true), _one(_key(PQ, vkC, 0, 1, ADMIN_SPEND))));
        vm.prank(g1);
        recovery.approve(address(a), resetCall);
        vm.prank(g2);
        recovery.approve(address(a), resetCall);
        (,,,, uint64 nonceBefore,) = recovery.setups(address(a));
        vm.startPrank(address(a));
        a.uninstallModule(ModuleType.EXECUTOR, address(recovery), "");
        address[] memory gs = new address[](3);
        (gs[0], gs[1], gs[2]) = (g1, g2, g3);
        a.installModule(ModuleType.EXECUTOR, address(recovery), abi.encode(gs, uint8(2), uint32(1 days)));
        vm.stopPrank();
        (,,,, uint64 nonceAfter,) = recovery.setups(address(a));
        assertEq(nonceAfter, nonceBefore + 2); // one for the uninstall, one for the install
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(GuardianRecovery.NotReady.selector);
        recovery.execute(address(a), resetCall);
    }

    /// Bug fix: a duplicated guardian counted twice towards `threshold`, so [g1, g1] with threshold 2 installed a
    /// recovery that could never complete.
    function test_duplicateGuardiansDoNotCountTwice() public {
        LeanAccount a = _pqAccount();
        vm.startPrank(address(a));
        a.uninstallModule(ModuleType.EXECUTOR, address(recovery), "");
        address[] memory gs = new address[](2);
        gs[0] = g1;
        gs[1] = g1;
        vm.expectRevert(GuardianRecovery.BadSetup.selector);
        a.installModule(ModuleType.EXECUTOR, address(recovery), abi.encode(gs, uint8(2), uint32(1 days)));
        vm.stopPrank();
    }

    function test_onlyGuardiansApprove() public {
        LeanAccount a = _pqAccount();
        vm.expectRevert(GuardianRecovery.NotGuardian.selector);
        recovery.approve(
            address(a), abi.encodeCall(KeystoreValidator.resetKeys, (_policy(1, 1, true), _one(_key(PQ, vkC, 0, 1, 3))))
        );
    }

    // ------------------------------------------------------------------------------------------ keystore rules --

    function test_keyRotationAndInvariants() public {
        LeanAccount a = _pqAccount();
        bytes32 idA = ks.keyIdOf(PQ, vkA, 0);
        vm.startPrank(address(a));
        vm.expectRevert(
            abi.encodeWithSelector(KeystoreValidator.Invariant.selector, "admin keys below the admin threshold")
        );
        ks.removeKey(idA); // the only key

        ks.rotateKey(idA, _key(PQ, vkB, 0, 1, ADMIN_SPEND));
        assertEq(ks.getKey(address(a), idA).kind, 0);
        assertEq(ks.getKey(address(a), ks.keyIdOf(PQ, vkB, 0)).kind, PQ);

        // requirePQ: the PQ admin cannot be swapped for a classical one
        bytes32 idB = ks.keyIdOf(PQ, vkB, 0);
        vm.expectRevert(
            abi.encodeWithSelector(KeystoreValidator.Invariant.selector, "requirePQ needs a post-quantum admin key")
        );
        ks.rotateKey(idB, _key(ECDSA, bytes32(uint256(uint160(ecdsaSigner))), 0, 1, ADMIN_SPEND));

        vm.expectRevert(
            abi.encodeWithSelector(KeystoreValidator.Invariant.selector, "admin keys below the admin threshold")
        );
        ks.setPolicy(_policy(2, 1, true));
        vm.stopPrank();
    }

    function test_migrateInPlaceFromAClassicalKey() public {
        // An account that starts classical (one ECDSA key, requirePQ off) becomes post-quantum, same address.
        LeanAccount a =
            _account(_one(_key(ECDSA, bytes32(uint256(uint160(ecdsaSigner))), 0, 1, ADMIN_SPEND)), _policy(1, 1, false));
        address before = address(a);
        bytes32 oldId = ks.keyIdOf(ECDSA, bytes32(uint256(uint160(ecdsaSigner))), 0);
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(
            address(ks), 0, abi.encodeCall(KeystoreValidator.rotateKey, (oldId, _key(PQ, vkA, 0, 1, ADMIN_SPEND)))
        );
        xs[1] = Execution(address(ks), 0, abi.encodeCall(KeystoreValidator.setPolicy, (_policy(1, 1, true))));
        bytes memory migrate = abi.encodeCall(
            LeanAccount.execute, (ExecMode.encode(ExecMode.CALLTYPE_BATCH, ExecMode.EXECTYPE_DEFAULT), abi.encode(xs))
        );
        _tx(a, "", _none(), migrate);
        txm.addSig(1, ecdsaSigner, 0, "");
        (bool ok,) = _verify(a);
        assertTrue(ok); // the classical key is still the admin at this point
        txm.setCurrentFrame(1);
        vm.prank(address(a));
        (ok,) = address(a).call(migrate);
        assertTrue(ok);
        assertEq(address(a), before);
        assertTrue(ks.getConfig(address(a)).requirePQ);

        // the old key no longer authorizes anything
        _tx(a, "", _none(), _single(address(sink), 0.01 ether, ""));
        txm.addSig(1, ecdsaSigner, 0, "");
        (ok,) = _verify(a);
        assertFalse(ok);
    }

    /// The slots validateFrame reads are keyed by the account as the innermost mapping key (ERC-7562 STO-021).
    function test_keystoreSlotsAreAssociatedWithTheAccount() public {
        LeanAccount a = _pqAccount();
        bytes32 id = ks.keyIdOf(PQ, vkA, 0);
        bytes32 keySlot = keccak256(abi.encode(address(a), keccak256(abi.encode(id, uint256(1))))); // _keys
        bytes32 vkSlot = bytes32(uint256(keySlot) + 1); // Key.a
        assertEq(vm.load(address(ks), vkSlot), vkA);
        bytes32 cfgSlot = keccak256(abi.encode(address(a), uint256(0))); // _config
        assertTrue(uint256(vm.load(address(ks), cfgSlot)) != 0);
    }

    // ------------------------------------------------------------------------------------------ account & factory

    function test_factoryIsDeterministicAndInitializesOnce() public {
        KeystoreValidator.KeyInit[] memory keys = _one(_key(PQ, vkA, 0, 1, ADMIN_SPEND));
        LeanAccountFactory.Init memory init = LeanAccountFactory.Init(
            address(ks), abi.encode(_policy(1, 1, true), keys), address(0), "", new address[](0), new bytes[](0)
        );
        address predicted = factory.predict(bytes32("s"), init);
        address created = factory.createAccount(bytes32("s"), init);
        assertEq(created, predicted);
        assertEq(factory.createAccount(bytes32("s"), init), created); // idempotent
        vm.expectRevert(LeanAccount.AlreadyInitialized.selector);
        LeanAccount(payable(created)).initialize(address(ks), "", address(0), "", new address[](0), new bytes[](0));
        vm.expectRevert(LeanAccount.AlreadyInitialized.selector);
        impl.initialize(address(ks), "", address(0), "", new address[](0), new bytes[](0));
    }

    function test_executeIsSelfOnlyAndRunsBatches() public {
        LeanAccount a = _pqAccount();
        vm.expectRevert(LeanAccount.OnlySelf.selector);
        a.execute(
            ExecMode.encode(ExecMode.CALLTYPE_SINGLE, ExecMode.EXECTYPE_DEFAULT),
            abi.encodePacked(address(sink), uint256(1), "")
        );

        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(address(sink), 0.1 ether, "");
        xs[1] = Execution(address(sink), 0, abi.encodeCall(Sink.poke, ()));
        _pq1(a, vkA, ""); // context for the hook: a full quorum
        vm.prank(address(a));
        a.execute(ExecMode.encode(ExecMode.CALLTYPE_BATCH, ExecMode.EXECTYPE_DEFAULT), abi.encode(xs));
        assertEq(sink.hits(), 2);
        assertEq(address(sink).balance, 0.1 ether);
    }

    function test_moduleConfig() public {
        LeanAccount a = _pqAccount();
        assertTrue(a.isModuleInstalled(ModuleType.FRAME_VALIDATOR, address(ks), ""));
        assertTrue(a.isModuleInstalled(ModuleType.HOOK, address(hook), ""));
        assertTrue(a.isModuleInstalled(ModuleType.EXECUTOR, address(recovery), ""));
        assertTrue(a.supportsExecutionMode(ExecMode.encode(ExecMode.CALLTYPE_FRAME_BATCH, ExecMode.EXECTYPE_DEFAULT)));
        assertFalse(a.supportsExecutionMode(ExecMode.encode(0xff, 0x00))); // delegatecall
        assertEq(a.executionRoute(), 1);
        assertTrue(a.supportsApprovalMode(3));
        assertFalse(a.supportsApprovalMode(0));
        vm.prank(address(a));
        vm.expectRevert(LeanAccount.LastValidator.selector);
        a.uninstallModule(ModuleType.FRAME_VALIDATOR, address(ks), "");
    }
    // ------------------------------------------------------------------------------------------ migration ---------

    uint256 constant OWNER_PK = 0xA11CE;
    bytes32 constant ERC1967_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function _leanInit(bytes32 vk) internal view returns (bytes memory) {
        return abi.encodeCall(
            LeanAccount.initialize,
            (
                address(ks),
                abi.encode(_policy(1, 1, true), _one(_key(PQ, vk, 0, 1, ADMIN_SPEND))),
                address(0),
                "",
                new address[](0),
                new bytes[](0)
            )
        );
    }

    function _legacyProxy(address owner_) internal returns (LegacyAccount a) {
        LegacyAccount legacyImpl = new LegacyAccount(address(0));
        a = LegacyAccount(
            payable(
                address(new LegacyERC1967Proxy(address(legacyImpl), abi.encodeCall(LegacyAccount.initialize, (owner_))))
            )
        );
        vm.deal(address(a), 1 ether);
    }

    function test_storageIsNamespaced() public {
        LeanAccount a = _pqAccount();
        for (uint256 i; i < 8; ++i) {
            assertEq(vm.load(address(a), bytes32(i)), bytes32(0));
        }
    }

    function test_migrateSA_upgradeKeepsTheAddressAndRetiresTheOldOwner() public {
        address owner_ = vm.addr(OWNER_PK);
        LegacyAccount legacy = _legacyProxy(owner_);
        TestToken t = new TestToken();
        t.mint(address(legacy), 5e18);

        vm.prank(owner_);
        legacy.upgradeToAndCall(address(impl), _leanInit(vkA));

        LeanAccount a = LeanAccount(payable(address(legacy)));
        assertEq(address(uint160(uint256(vm.load(address(a), ERC1967_SLOT)))), address(impl));
        assertEq(address(a).balance, 1 ether);
        assertEq(t.balanceOf(address(a)), 5e18);
        assertTrue(a.isModuleInstalled(ModuleType.FRAME_VALIDATOR, address(ks), ""));

        _pq1(a, vkA, _single(address(sink), 0.1 ether, ""));
        (bool ok,) = _verify(a);
        assertTrue(ok);

        LegacyAccount.Call[] memory calls = new LegacyAccount.Call[](1);
        calls[0] = LegacyAccount.Call(owner_, 1 ether, "");
        vm.prank(owner_);
        (ok,) = address(a).call(abi.encodeCall(LegacyAccount.execute, (calls)));
        assertFalse(ok, "the old owner's execute is gone");
        vm.prank(owner_);
        vm.expectRevert(LeanAccount.OnlySelf.selector);
        a.execute(bytes32(0), abi.encodePacked(owner_, uint256(1 ether), ""));
        vm.prank(owner_);
        vm.expectRevert(LeanAccount.OnlySelf.selector);
        a.upgradeToAndCall(address(impl), "");
    }

    function test_migrateSA_leanAccountIsUUPS() public {
        assertEq(impl.proxiableUUID(), ERC1967_SLOT);
        LeanAccount clone = _pqAccount();
        vm.expectRevert(LeanAccount.UUPSUnauthorizedCallContext.selector);
        clone.proxiableUUID();
        vm.prank(address(clone));
        vm.expectRevert(LeanAccount.NotProxy.selector);
        clone.upgradeToAndCall(address(impl), "");

        LegacyAccount legacy = _legacyProxy(vm.addr(OWNER_PK));
        vm.prank(vm.addr(OWNER_PK));
        legacy.upgradeToAndCall(address(impl), _leanInit(vkA));
        LeanAccount a = LeanAccount(payable(address(legacy)));
        LeanAccount impl2 = new LeanAccount(hub);
        vm.prank(address(a));
        vm.expectEmit(address(a));
        emit Upgraded(address(impl2));
        a.upgradeToAndCall(address(impl2), "");
        assertEq(address(uint160(uint256(vm.load(address(a), ERC1967_SLOT)))), address(impl2));
        vm.prank(address(a));
        vm.expectRevert(LeanAccount.NotUUPS.selector);
        a.upgradeToAndCall(address(sink), "");
        vm.prank(address(a));
        vm.expectRevert(LeanAccount.NotUUPS.selector);
        a.upgradeToAndCall(makeAddr("no code"), "");
    }

    function test_migrateSA_upgradeCannotBeReinitialized() public {
        LegacyAccount legacy = _legacyProxy(vm.addr(OWNER_PK));
        vm.prank(vm.addr(OWNER_PK));
        legacy.upgradeToAndCall(address(impl), _leanInit(vkA));
        (bool ok, bytes memory err) = address(legacy).call(_leanInit(vkB));
        assertFalse(ok);
        assertEq(bytes4(err), LeanAccount.AlreadyInitialized.selector);
    }

    function test_migrateSA_moveOutOfANonUpgradeableAccount() public {
        address owner_ = vm.addr(OWNER_PK);
        LegacyAccount legacy = new LegacyAccount(owner_);
        vm.deal(address(legacy), 1 ether);
        TestToken t = new TestToken();
        t.mint(address(legacy), 5e18);
        vm.prank(owner_);
        vm.expectRevert(bytes("not a proxy"));
        legacy.upgradeToAndCall(address(impl), "");

        LeanAccountFactory.Init memory init = LeanAccountFactory.Init(
            address(ks),
            abi.encode(_policy(1, 1, true), _one(_key(PQ, vkA, 0, 1, ADMIN_SPEND))),
            address(hook),
            "",
            new address[](0),
            new bytes[](0)
        );
        address target = factory.predict(bytes32(uint256(77)), init);
        LegacyAccount.Call[] memory calls = new LegacyAccount.Call[](2);
        calls[0] = LegacyAccount.Call(address(t), 0, abi.encodeCall(TestToken.transfer, (target, 5e18)));
        calls[1] = LegacyAccount.Call(
            address(factory), 1 ether, abi.encodeCall(LeanAccountFactory.createAccount, (bytes32(uint256(77)), init))
        );
        vm.prank(owner_);
        legacy.execute(calls);
        assertEq(t.balanceOf(target), 5e18);
        assertEq(target.balance, 1 ether);
        assertEq(address(legacy).balance, 0);
        assertGt(target.code.length, 0);
    }

    function test_migrateEOA_7702OverDirtyStorageInitializesOnlyItself() public {
        address eoa = vm.addr(OWNER_PK);
        vm.deal(eoa, 1 ether);
        // an earlier delegation left state in the EOA's low slots
        vm.signAndAttachDelegation(address(new LegacyAccount(address(0))), OWNER_PK);
        vm.prank(eoa);
        LegacyAccount(payable(eoa)).initialize(eoa);
        assertTrue(vm.load(eoa, bytes32(uint256(2))) != bytes32(0));

        vm.signAndAttachDelegation(address(impl), OWNER_PK);
        assertEq(eoa.code.length, 23);
        (bool ok, bytes memory err) = eoa.call(_leanInit(vkA)); // a third party, before the owner
        assertFalse(ok);
        assertEq(bytes4(err), LeanAccount.OnlySelf.selector);
        vm.prank(eoa);
        (ok,) = eoa.call(_leanInit(vkA));
        assertTrue(ok);

        LeanAccount a = LeanAccount(payable(eoa));
        _pq1(a, vkA, _single(address(sink), 0.1 ether, ""));
        (ok,) = _verify(a);
        assertTrue(ok);
    }
    // ------------------------------------------------------------------------------------------ session tokens ---

    uint8 constant EIP712 = 5;

    function _tokenSession() internal returns (LeanAccount a, address s, bytes32 sid, TestToken t) {
        (a, s, sid) = _sessionAccount();
        t = new TestToken();
        t.mint(address(a), 1000e18);
        vm.startPrank(address(a));
        ks.setSessionTargets(sid, _addrs(address(t)), true);
        ks.setSessionToken(sid, address(t), 100e18);
        vm.stopPrank();
    }

    function _addrs(address x) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = x;
    }

    function _batch(Execution[] memory xs) internal pure returns (bytes memory) {
        return abi.encodeCall(
            LeanAccount.execute, (ExecMode.encode(ExecMode.CALLTYPE_BATCH, ExecMode.EXECTYPE_DEFAULT), abi.encode(xs))
        );
    }

    function _sessionVerify(LeanAccount a, address s, bytes memory senderCall) internal returns (bool ok) {
        _tx(a, "", _none(), senderCall);
        txm.addSig(1, s, 0, "");
        (ok,) = _verify(a);
    }

    function test_sessionTokenTransferWithinItsPerTxCap() public {
        (LeanAccount a, address s,, TestToken t) = _tokenSession();
        address to = makeAddr("shop");
        assertTrue(_sessionVerify(a, s, _single(address(t), 0, abi.encodeCall(TestToken.transfer, (to, 100e18)))));
        assertFalse(_sessionVerify(a, s, _single(address(t), 0, abi.encodeCall(TestToken.transfer, (to, 101e18)))));
        assertFalse(
            _sessionVerify(
                a, s, _single(address(t), 0, abi.encodeCall(TestToken.transferFrom, (address(a), to, 101e18)))
            )
        );
    }

    function test_sessionTokenAmountsAreSummedAcrossABatch() public {
        (LeanAccount a, address s,, TestToken t) = _tokenSession();
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(address(t), 0, abi.encodeCall(TestToken.transfer, (makeAddr("x"), 60e18)));
        xs[1] = Execution(address(t), 0, abi.encodeCall(TestToken.transfer, (makeAddr("y"), 60e18)));
        assertFalse(_sessionVerify(a, s, _batch(xs))); // 120 > 100
        xs[1].callData = abi.encodeCall(TestToken.transfer, (makeAddr("y"), 40e18));
        assertTrue(_sessionVerify(a, s, _batch(xs))); // 100
    }

    function test_sessionCannotMoveAnUncappedToken() public {
        (LeanAccount a, address s, bytes32 sid,) = _tokenSession();
        TestToken other = new TestToken();
        other.mint(address(a), 1e18);
        vm.prank(address(a));
        ks.setSessionTargets(sid, _addrs(address(other)), true); // allowlisted, but no token cap
        assertFalse(_sessionVerify(a, s, _single(address(other), 0, abi.encodeCall(TestToken.transfer, (s, 1)))));
    }

    function test_sessionCannotGrantAllowancesOrMoveNfts() public {
        (LeanAccount a, address s,, TestToken t) = _tokenSession();
        bytes[] memory refused = new bytes[](10);
        refused[0] = abi.encodeWithSelector(0x095ea7b3, s, 1); // approve
        refused[1] = abi.encodeWithSelector(0x39509351, s, 1); // increaseAllowance
        refused[2] = abi.encodeWithSelector(0xa22cb465, s, true); // setApprovalForAll
        refused[3] = abi.encodeWithSelector(0x42842e0e, address(a), s, 1); // ERC-721 safeTransferFrom
        refused[4] = abi.encodeWithSelector(0xb88d4fde, address(a), s, 1, ""); // ERC-721 safeTransferFrom + data
        refused[5] = abi.encodeWithSelector(0xf242432a, address(a), s, 1, 1, ""); // ERC-1155 safeTransferFrom
        refused[6] = abi.encodeWithSelector(0xd505accf, address(a), s, 1, 1, 27, bytes32(0), bytes32(0)); // permit
        refused[7] = abi.encodeWithSelector(0x87517c45, address(t), s, uint160(1), uint48(1)); // Permit2 approve
        refused[8] = abi.encodeWithSelector(0x9bd9bbc6, s, 1, ""); // ERC-777 send
        refused[9] = abi.encodeWithSelector(0x2eb2c2d6, address(a), s, new uint256[](0), new uint256[](0), ""); // ERC-1155 batch
        for (uint256 i; i < refused.length; ++i) {
            assertFalse(_sessionVerify(a, s, _single(address(t), 0, refused[i])), "selector refused");
        }
    }

    function test_theOwnerIsNotLimitedByTokenRules() public {
        (LeanAccount a,,, TestToken t) = _tokenSession();
        _pq1(a, vkA, _single(address(t), 0, abi.encodeCall(TestToken.approve, (makeAddr("dex"), 500e18))));
        (bool ok,) = _verify(a);
        assertTrue(ok, "approve");
        sh = keccak256("owner tx 2"); // each PQ tx posts its own root
        _pq1(a, vkA, _single(address(t), 0, abi.encodeCall(TestToken.transfer, (makeAddr("x"), 500e18))));
        (ok,) = _verify(a);
        assertTrue(ok, "over the session's per-tx cap");
        sh = keccak256("owner tx 3");
        TestToken other = new TestToken();
        _pq1(a, vkA, _single(address(other), 0, abi.encodeCall(TestToken.transfer, (makeAddr("x"), 1))));
        (ok,) = _verify(a);
        assertTrue(ok, "a token no session may touch");
    }

    function test_sessionTokenAmountsAreSummedAcrossSenderFrames() public {
        (LeanAccount a, address s,, TestToken t) = _tokenSession();
        _tx(a, "", _none(), _single(address(t), 0, abi.encodeCall(TestToken.transfer, (makeAddr("x"), 60e18))));
        txm.addFrame(
            2, address(0), 0, _single(address(t), 0, abi.encodeCall(TestToken.transfer, (makeAddr("y"), 60e18)))
        );
        txm.addSig(1, s, 0, "");
        (bool ok,) = _verify(a);
        assertFalse(ok); // 60 + 60 across two SENDER frames > 100
    }

    function test_hookEnforcesADailyTokenCap() public {
        (LeanAccount a, address s, bytes32 sid, TestToken t) = _tokenSession();
        vm.prank(address(a));
        hook.setTokenDailyCap(sid, address(t), 150e18);
        address to = makeAddr("shop");
        bytes memory pay = _single(address(t), 0, abi.encodeCall(TestToken.transfer, (to, 100e18)));
        _tx(a, "", _none(), pay);
        txm.addSig(1, s, 0, "");
        txm.setCurrentFrame(1);
        vm.prank(address(a));
        (bool ok,) = address(a).call(pay);
        assertTrue(ok);
        assertEq(hook.tokenLimitOf(address(a), sid, address(t)).spent, 100e18);

        vm.prank(address(a));
        (ok,) = address(a).call(pay); // 200 > 150 today
        assertFalse(ok);
        assertEq(t.balanceOf(to), 100e18);

        vm.warp(block.timestamp + 1 days);
        vm.prank(address(a));
        (ok,) = address(a).call(pay);
        assertTrue(ok);
        assertEq(t.balanceOf(to), 200e18);
    }

    function test_hookDoesNotLimitTheOwnersTokens() public {
        (LeanAccount a,, bytes32 sid, TestToken t) = _tokenSession();
        vm.prank(address(a));
        hook.setTokenDailyCap(sid, address(t), 1);
        bytes memory pay = _single(address(t), 0, abi.encodeCall(TestToken.transfer, (makeAddr("x"), 500e18)));
        _pq1(a, vkA, pay);
        txm.setCurrentFrame(1);
        vm.prank(address(a));
        (bool ok,) = address(a).call(pay);
        assertTrue(ok);
    }

    // ------------------------------------------------------------------------------------------ EIP-712 keys -----

    uint256 constant MM_PK = 0xBEEF;

    function _callsHash(Execution[] memory xs) internal pure returns (bytes32) {
        bytes32[] memory hs = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) {
            hs[i] = keccak256(
                abi.encode(
                    keccak256("Call(address to,uint256 value,bytes data)"),
                    xs[i].target,
                    xs[i].value,
                    keccak256(xs[i].callData)
                )
            );
        }
        return keccak256(abi.encodePacked(hs));
    }

    function _digest712(address account, bytes32 sigHash, Execution[] memory xs) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("LeanAccount"),
                keccak256("1"),
                block.chainid,
                account
            )
        );
        bytes32 st = keccak256(
            abi.encode(
                keccak256("LeanAccountTx(bytes32 sigHash,Call[] calls)Call(address to,uint256 value,bytes data)"),
                sigHash,
                _callsHash(xs)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, st));
    }

    function _mmAccount(uint8 roles) internal returns (LeanAccount a, bytes32 id) {
        address mm = vm.addr(MM_PK);
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](2);
        keys[0] = _key(PQ, vkA, 0, 1, ADMIN_SPEND);
        keys[1] = _key(EIP712, bytes32(uint256(uint160(mm))), 0, 1, roles);
        if (roles == SESSION) {
            keys[1].perTxCap = 0.05 ether;
            keys[1].sessionTargets = _addrs(address(sink));
        }
        a = _account(keys, _policy(1, 1, true));
        id = ks.keyIdOf(EIP712, bytes32(uint256(uint160(mm))), 0);
    }

    function _one(address to, uint256 value, bytes memory data) internal pure returns (Execution[] memory xs) {
        xs = new Execution[](1);
        xs[0] = Execution(to, value, data);
    }

    /// The tx [VERIFY(account.verify(ks, envelope with entry 0)), SENDER(execute single)] with entry 0 = the typed
    /// signature over (signedHash, signedCalls).
    function _mmTx(
        LeanAccount a,
        bytes32 id,
        uint256 pk,
        address acctForDomain,
        bytes32 signedHash,
        Execution[] memory signedCalls,
        uint256 value
    ) internal returns (bool ok) {
        uint256[] memory entries = new uint256[](1);
        _tx(a, "", entries, _single(address(sink), value, ""));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, _digest712(acctForDomain, signedHash, signedCalls));
        txm.addSig(0, address(0), 0, abi.encode(id, abi.encodePacked(r, s_, v)));
        (ok,) = _verify(a);
    }

    function test_eip712KeySignsLikeMetaMask() public {
        (LeanAccount a, bytes32 id) = _mmAccount(SPEND);
        Execution[] memory calls = _one(address(sink), 0.1 ether, "");
        assertTrue(_mmTx(a, id, MM_PK, address(a), sh, calls, 0.1 ether)); // verify() returned: APPROVE ran
    }

    function test_eip712RefusesWrongSignerTamperedCallsOtherDomainOrHash() public {
        (LeanAccount a, bytes32 id) = _mmAccount(SPEND);
        Execution[] memory calls = _one(address(sink), 0.1 ether, "");
        assertFalse(_mmTx(a, id, 0xBAD, address(a), sh, calls, 0.1 ether), "wrong signer");
        assertFalse(
            _mmTx(a, id, MM_PK, address(a), sh, _one(address(sink), 0.001 ether, ""), 0.1 ether), "calls shown differ"
        );
        assertFalse(_mmTx(a, id, MM_PK, makeAddr("another account"), sh, calls, 0.1 ether), "other domain");
        assertFalse(_mmTx(a, id, MM_PK, address(a), keccak256("another tx"), calls, 0.1 ether), "other sig hash");
    }

    function test_eip712RefusesHighS() public {
        (LeanAccount a, bytes32 id) = _mmAccount(SPEND);
        Execution[] memory calls = _one(address(sink), 0.1 ether, "");
        uint256[] memory entries = new uint256[](1);
        _tx(a, "", entries, _single(address(sink), 0.1 ether, ""));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(MM_PK, _digest712(address(a), sh, calls));
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s_));
        txm.addSig(0, address(0), 0, abi.encode(id, abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27))));
        (bool ok,) = _verify(a);
        assertFalse(ok);
    }

    function test_eip712KeyAsASessionKey() public {
        (LeanAccount a, bytes32 id) = _mmAccount(SESSION);
        assertTrue(_mmTx(a, id, MM_PK, address(a), sh, _one(address(sink), 0.05 ether, ""), 0.05 ether));
        assertFalse(_mmTx(a, id, MM_PK, address(a), sh, _one(address(sink), 0.06 ether, ""), 0.06 ether), "over cap");
        _mmTx(a, id, MM_PK, address(a), sh, _one(address(sink), 0.01 ether, ""), 0.01 ether);
        txm.setCurrentFrame(1);
        (bool allowed, bool full, bytes32 key) = ks.executionContext(address(a));
        assertTrue(allowed);
        assertFalse(full);
        assertEq(key, id);
    }

    function test_eip712DigestMatchesTheSdkAndAViemSignature() public {
        string memory json = vm.readFile("test/account/fixtures/eip712-vector.json");
        vm.chainId(1337); // the devnet's chain id, which the SDK's typed data commits to
        Execution[] memory calls = new Execution[](2);
        for (uint256 i; i < 2; ++i) {
            string memory c = string.concat(".calls[", vm.toString(i), "]");
            calls[i] = Execution(
                vm.parseJsonAddress(json, string.concat(c, ".target")),
                vm.parseJsonUint(json, string.concat(c, ".value")),
                vm.parseJsonBytes(json, string.concat(c, ".callData"))
            );
        }
        bytes32 digest =
            ks.hashTypedTx(vm.parseJsonAddress(json, ".account"), vm.parseJsonBytes32(json, ".sigHash"), calls);
        assertEq(digest, vm.parseJsonBytes32(json, ".digest"));
        bytes memory sig = vm.parseJsonBytes(json, ".signature");
        (bytes32 r, bytes32 s_) = (bytes32(_slice(sig, 0)), bytes32(_slice(sig, 32)));
        assertEq(ecrecover(digest, uint8(sig[64]), r, s_), vm.parseJsonAddress(json, ".signer"));
    }

    function _slice(bytes memory b, uint256 at) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 32), at))
        }
    }
    // ------------------------------------------------------------------------------------------ review fixes ------

    function test_aCappedTokenAllowsOnlyTransferAndTransferFrom() public {
        (LeanAccount a, address s,, TestToken t) = _tokenSession();
        bytes[] memory refused = new bytes[](5);
        refused[0] = abi.encodeWithSelector(0x4000aea0, s, 1, ""); // ERC-1363 transferAndCall(address,uint256,bytes)
        refused[1] = abi.encodeWithSelector(0x1296ee62, s, 1); // ERC-1363 transferAndCall(address,uint256)
        refused[2] = abi.encodeWithSelector(0xb753a98c, s, 1); // DAI push
        refused[3] = abi.encodeWithSelector(0x42966c68, 1); // burn
        refused[4] = abi.encodeWithSelector(0xd73dd623, s, 1); // increaseApproval
        for (uint256 i; i < refused.length; ++i) {
            assertFalse(_sessionVerify(a, s, _single(address(t), 0, refused[i])), "only transfer/transferFrom");
        }
    }

    function test_maxUintTransferIsCountedNotSkipped() public {
        (LeanAccount a, address s,, TestToken t) = _tokenSession();
        assertFalse(
            _sessionVerify(a, s, _single(address(t), 0, abi.encodeCall(TestToken.transfer, (s, type(uint256).max))))
        );
    }

    function test_sessionEthCapIsPerTxNotPerCall() public {
        (LeanAccount a, address s,) = _sessionAccount(); // 0.05 ETH per tx
        Execution[] memory xs = new Execution[](2);
        xs[0] = Execution(address(sink), 0.03 ether, "");
        xs[1] = Execution(address(sink), 0.03 ether, "");
        assertFalse(_sessionVerify(a, s, _batch(xs))); // 0.06 > 0.05
        xs[1].value = 0.02 ether;
        assertTrue(_sessionVerify(a, s, _batch(xs)));
    }

    function test_anyoneCanPruneAnExpiredKeyThenVerifyRefusesIt() public {
        (LeanAccount a, address s, bytes32 sid) = _sessionAccount();
        vm.expectRevert(abi.encodeWithSelector(KeystoreValidator.NotExpired.selector, sid));
        ks.pruneExpired(address(a), sid);
        vm.warp(block.timestamp + 8 days);
        vm.prank(makeAddr("anyone"));
        ks.pruneExpired(address(a), sid);
        assertEq(ks.getKey(address(a), sid).kind, 0);
        assertFalse(_sessionVerify(a, s, _single(address(sink), 0.01 ether, "")));
    }

    function test_eip712AcceptsV0And1() public {
        (LeanAccount a, bytes32 id) = _mmAccount(SPEND);
        Execution[] memory calls = _one(address(sink), 0.1 ether, "");
        uint256[] memory entries = new uint256[](1);
        _tx(a, "", entries, _single(address(sink), 0.1 ether, ""));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(MM_PK, _digest712(address(a), sh, calls));
        txm.addSig(0, address(0), 0, abi.encode(id, abi.encodePacked(r, s_, v - 27)));
        (bool ok,) = _verify(a);
        assertTrue(ok);
    }
}

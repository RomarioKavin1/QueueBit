// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {DepsRegistry} from "../../src/leanpool/DepsRegistry.sol";
import {LeanPoolMerkle} from "../../src/leanpool/LeanPoolMerkle.sol";
import {LeanPoolHotSigner} from "../../src/roles/LeanPoolHotSigner.sol";
import {LeanPoolHotSignerFactory} from "../../src/roles/LeanPoolHotSignerFactory.sol";
import {AccountTestBase} from "../account/AccountTestBase.sol";

/// The PQ everyday path end to end under FrameSim: a real QueueBit account, a real `LeanPoolHotSigner` clone from its
/// factory, a real `DepsRegistry` with a bonded aggregator. VERIFY runs in the signer (LeanPool inclusion proof), the
/// SENDER frame spends through `hotExecuteFrom` under the account's everyday limits.
contract LeanPoolHotPathTest is AccountTestBase {
    uint256 internal constant SCHEME = 0x10;
    bytes32 internal constant PQ_PK = keccak256("queuebit.test.leanpool-pk");
    bytes32 internal constant SIG_HASH = keccak256("queuebit.test.leanpool-sighash");
    uint96 internal constant HOT_MAX_FEE = 0.02 ether;
    uint256 internal constant COST = 0.005 ether;
    uint64 internal constant VERIFY_GAS = 100_000;

    DepsRegistry internal registry;
    LeanPoolHotSignerFactory internal hotFactory;
    LeanPoolHotSigner internal signer;
    address internal aggregator = makeAddr("aggregator");
    address internal otherAggregator = makeAddr("otherAggregator");

    // The batch the aggregator posts: our leaf and two others; proof for ours = [b, c].
    bytes32 internal leafB = keccak256("b");
    bytes32 internal leafC = keccak256("c");

    function setUp() public override {
        super.setUp();
        registry = new DepsRegistry(0.01 ether);
        vm.deal(aggregator, 1 ether);
        vm.deal(otherAggregator, 1 ether);
        vm.prank(aggregator);
        registry.bond{value: 0.01 ether}();
        vm.prank(otherAggregator);
        registry.bond{value: 0.01 ether}();
        hotFactory = new LeanPoolHotSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_COST, address(registry));
        simAttach(address(hotFactory.implementation()));
        signer = LeanPoolHotSigner(
            payable(hotFactory.createHotSigner{value: 1 ether}(address(account), aggregator, PQ_PK, HOT_MAX_FEE))
        );
        vm.label(address(signer), "pqHotSigner");
        vm.prank(vault);
        roles.vaultSetPQHotSigner(address(signer));
    }

    // ------------------------------------------------------------------------------------------ builders ------

    function _triple(bytes32 dataHash, bytes32 key) internal pure returns (bytes memory) {
        return abi.encode(SCHEME, dataHash, key);
    }

    function _leaf(bytes32 sigHash, bytes32 key) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(SCHEME, sigHash, key));
    }

    function _proof() internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leafB;
        p[1] = leafC;
    }

    function _rootFor(bytes32 leaf) internal view returns (bytes32) {
        return LeanPoolMerkle.hashPair(LeanPoolMerkle.hashPair(leaf, leafB), leafC);
    }

    /// Posts the batch holding our leaf into the signer's ring; returns (root, ring position).
    function _post(address agg, bytes32 leaf) internal returns (bytes32 root, uint8 ring) {
        root = _rootFor(leaf);
        address[] memory w = new address[](1);
        w[0] = address(signer);
        vm.prank(agg);
        ring = registry.postRoot(root, 3, w);
    }

    function _witness(bytes32 root, uint8 ring) internal view returns (bytes memory) {
        return abi.encode(root, ring, _proof());
    }

    function _pay(uint256 declared, IQueueBitAccount.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(LeanPoolHotSigner.execute, (declared, calls));
    }

    /// [VERIFY 0x3 (null, triple), SENDER(null, execute(...))], signatures [ARBITRARY witness].
    function _tx(bytes memory triple, bytes memory senderData, bytes memory witness) internal {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(SIG_HASH);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, triple);
        simSender(address(0), 500_000, 0, senderData);
        simAddArbitrary(witness);
    }

    function _validTx(uint256 declared, IQueueBitAccount.Call[] memory calls) internal {
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        _tx(_triple(0, PQ_PK), _pay(declared, calls), _witness(root, ring));
    }

    function _ringSlot(address agg, address wallet, uint8 i) internal pure returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(agg, uint256(2)));
        return bytes32(uint256(keccak256(abi.encode(wallet, inner))) + i);
    }

    // ------------------------------------------------------------------------------------------ happy path ------

    function test_pqPayment_movesFunds_debitsBucket_selfPaid() public {
        _validTx(100 * USD, _one(_usdcTransfer(alice, 100 * USD)));
        SimResult memory r = simRunValid();
        assertEq(r.payer, address(signer), "the signer pays for itself");
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(usdc.balanceOf(alice), 100 * USD);
        assertEq(_bucketAvailable(), CAP - 100 * USD, "same bucket as the hot key");
        // FrameSim's mocked opcodes make gas only indicative; the VERIFY budget (< 100k) is measured on the devnet with
        // ethrex_simulateFrameTransaction (contracts/devnet-tests/leanpool).
    }

    function test_verify_readsOnlyItsOwnRingSlot() public {
        _validTx(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        SimResult memory r = simRunValid();
        assertFalse(r.frames[0].staticViolation, "VERIFY static");
        assertEq(r.frames[0].bannedAccesses, 0, "VERIFY banned accesses");
        assertEq(r.frames[0].foreignSloads, 1, "one read outside the sender: its ring slot");
        assertEq(r.frames[0].firstForeignAccount, address(registry));
        assertEq(
            r.frames[0].firstForeignSlot,
            _ringSlot(aggregator, address(signer), 0),
            "the slot is keyed by the sender (ERC-7562 STO-021)"
        );
    }

    function test_secondPayment_laterRingPosition() public {
        _validTx(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        simRunValid();
        bytes32 sh2 = keccak256("second");
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(sh2, PQ_PK));
        assertEq(ring, 1);
        _tx(_triple(0, PQ_PK), _pay(2 * USD, _one(_usdcTransfer(alice, 2 * USD))), _witness(root, ring));
        simSetSigHash(sh2);
        simRunValid();
        assertEq(usdc.balanceOf(alice), 3 * USD);
    }

    // ---------------------------------------------------------------------------------- VERIFY refusals ------

    function _assertInvalid() internal {
        SimResult memory r = simRun();
        assertFalse(r.valid, "VERIFY must refuse");
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_rootNotPosted_refused() public {
        bytes32 root = _rootFor(_leaf(SIG_HASH, PQ_PK));
        _tx(_triple(0, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, 0));
        _assertInvalid();
    }

    function test_rootFromAnotherAggregator_refused() public {
        (bytes32 root, uint8 ring) = _post(otherAggregator, _leaf(SIG_HASH, PQ_PK));
        _tx(_triple(0, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, ring));
        _assertInvalid();
    }

    function test_leafForAnotherSigHash_refused() public {
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(keccak256("other tx"), PQ_PK));
        _tx(_triple(0, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, ring));
        _assertInvalid();
    }

    function test_anotherKey_refused() public {
        bytes32 other = keccak256("other key");
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(SIG_HASH, other));
        _tx(_triple(0, other), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, ring));
        _assertInvalid();
    }

    function test_foreignDataHash_refused() public {
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        _tx(_triple(SIG_HASH, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, ring));
        _assertInvalid();
    }

    function test_badScheme_refused() public {
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        _tx(
            abi.encode(uint256(0x11), bytes32(0), PQ_PK),
            _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))),
            _witness(root, ring)
        );
        _assertInvalid();
    }

    function test_badRingPosition_refused() public {
        (bytes32 root,) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        _tx(_triple(0, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, 8));
        _assertInvalid();
    }

    function test_wrongRingPosition_refused() public {
        (bytes32 root,) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        _tx(_triple(0, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, 3));
        _assertInvalid();
    }

    function test_truncatedWitness_refused() public {
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        bytes memory w = _witness(root, ring);
        assembly ("memory-safe") {
            mstore(w, sub(mload(w), 32))
        }
        _tx(_triple(0, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), w);
        _assertInvalid();
    }

    function test_feeAboveBound_refused() public {
        _validTx(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        simSetFees(1 gwei, 2 gwei, uint256(HOT_MAX_FEE) + 1);
        _assertInvalid();
    }

    function test_wrongSenderSelector_refused() public {
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        _tx(_triple(0, PQ_PK), abi.encodeWithSignature("vk()"), _witness(root, ring));
        _assertInvalid();
    }

    function test_extraFrame_refused() public {
        _validTx(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        simSender(address(0), 100_000, 0, _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))));
        _assertInvalid();
    }

    function test_secondSignature_refused() public {
        _validTx(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        simAddArbitrary(hex"00");
        _assertInvalid();
    }

    function test_ringEviction_oldRootRefused() public {
        (bytes32 root, uint8 ring) = _post(aggregator, _leaf(SIG_HASH, PQ_PK));
        address[] memory w = new address[](1);
        w[0] = address(signer);
        for (uint256 i = 1; i <= 8; i++) {
            vm.prank(aggregator);
            registry.postRoot(keccak256(abi.encode("filler", i)), 1, w);
        }
        _tx(_triple(0, PQ_PK), _pay(1 * USD, _one(_usdcTransfer(alice, 1 * USD))), _witness(root, ring));
        _assertInvalid();
    }

    // ---------------------------------------------------------------------- execution: everyday limits ------

    function test_overPerPaymentMax_revertsInExecution() public {
        _validTx(PER_TX + 1, _one(_usdcTransfer(alice, PER_TX + 1)));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(_bucketAvailable(), CAP);
    }

    function test_frozen_revertsInExecution() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        _validTx(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), IQueueBitAccount.HotFrozen.selector);
    }

    function test_removedSigner_revertsInExecution() public {
        vm.prank(vault);
        roles.vaultSetPQHotSigner(address(0));
        _validTx(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), IQueueBitAccount.Unauthorized.selector);
        assertEq(usdc.balanceOf(alice), 0);
    }

    // ------------------------------------------------------------------------------ account entry & setter ------

    function test_hotExecuteFrom_onlyTheInstalledSigner() public {
        vm.expectRevert(IQueueBitAccount.Unauthorized.selector);
        vm.prank(stranger);
        account.hotExecuteFrom(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
        vm.expectRevert(IQueueBitAccount.Unauthorized.selector);
        vm.prank(address(account));
        account.hotExecuteFrom(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
    }

    function test_hotExecuteFrom_noSignerInstalled_nobodyPasses() public {
        vm.prank(vault);
        roles.vaultSetPQHotSigner(address(0));
        vm.expectRevert(IQueueBitAccount.Unauthorized.selector);
        vm.prank(address(0));
        account.hotExecuteFrom(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
    }

    function test_setter_onlyVault() public {
        vm.expectRevert(IQueueBitAccount.Unauthorized.selector);
        vm.prank(stranger);
        roles.vaultSetPQHotSigner(address(0));
    }

    function test_setter_refusesSignerOfAnotherAccount() public {
        address other = hotFactory.createHotSigner(stranger, aggregator, PQ_PK, HOT_MAX_FEE);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.BadAddress.selector, other));
        vm.prank(vault);
        roles.vaultSetPQHotSigner(other);
    }

    function test_setter_refusesEoaAndRoleAddresses() public {
        vm.startPrank(vault);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.BadAddress.selector, alice));
        roles.vaultSetPQHotSigner(alice);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.BadAddress.selector, hot));
        roles.vaultSetPQHotSigner(hot);
        vm.expectRevert(abi.encodeWithSelector(IQueueBitAccount.BadAddress.selector, vault));
        roles.vaultSetPQHotSigner(vault);
        vm.stopPrank();
    }

    function test_setter_emitsAndIsReadable() public {
        address next = hotFactory.createHotSigner(address(account), otherAggregator, PQ_PK, HOT_MAX_FEE);
        vm.expectEmit(address(account));
        emit IQueueBitAccount.PQHotSignerSet(address(signer), next);
        vm.prank(vault);
        roles.vaultSetPQHotSigner(next);
        assertEq(roles.pqHotSigner(), next);
    }

    function test_setter_reachableFromAQueuedOp() public {
        address next = hotFactory.createHotSigner(address(account), otherAggregator, PQ_PK, HOT_MAX_FEE);
        _queueAndExecute(_one(_selfCall(abi.encodeCall(QueueBitAccountRoles.vaultSetPQHotSigner, (next)))), 1);
        assertEq(roles.pqHotSigner(), next);
    }

    // ------------------------------------------------------------------------------------- signer & factory ------

    function test_signer_args() public view {
        assertEq(signer.account(), address(account));
        assertEq(signer.registry(), address(registry));
        assertEq(signer.aggregator(), aggregator);
        assertEq(signer.vk(), PQ_PK);
        assertEq(signer.pk(), PQ_PK);
        assertEq(signer.maxFee(), HOT_MAX_FEE);
    }

    function test_factory_deterministic_idempotent() public {
        address p = hotFactory.predictHotSigner(address(account), aggregator, PQ_PK, HOT_MAX_FEE);
        assertEq(p, address(signer));
        assertEq(hotFactory.createHotSigner(address(account), aggregator, PQ_PK, HOT_MAX_FEE), address(signer));
    }

    function test_factory_refusesEmptyConfig() public {
        vm.expectRevert(LeanPoolHotSignerFactory.InvalidConfig.selector);
        hotFactory.createHotSigner(address(account), address(0), PQ_PK, HOT_MAX_FEE);
        vm.expectRevert(LeanPoolHotSignerFactory.InvalidConfig.selector);
        hotFactory.createHotSigner(address(account), aggregator, bytes32(0), HOT_MAX_FEE);
    }

    function test_execute_onlySelf() public {
        vm.expectRevert(LeanPoolHotSigner.OnlySelf.selector);
        vm.prank(stranger);
        signer.execute(1 * USD, _one(_usdcTransfer(alice, 1 * USD)));
    }

    function test_implementation_refusesToVerify() public {
        LeanPoolHotSigner implementation = hotFactory.implementation();
        vm.expectRevert(LeanPoolHotSigner.NotClone.selector);
        (bool ok,) = address(implementation).call(_triple(0, PQ_PK));
        ok;
    }
}

/// A stand-in signer for the parity suite: the account only checks `account()` at install and `msg.sender` after.
contract ParityHotSigner {
    address public immutable account;

    constructor(address a) {
        account = a;
    }
}

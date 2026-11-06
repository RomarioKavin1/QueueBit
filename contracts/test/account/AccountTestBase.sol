// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IStakingRegistry} from "../../src/interfaces/IStakingRegistry.sol";
import {RoleSignerFactory} from "../../src/roles/RoleSignerFactory.sol";
import {FrameSim} from "../frame/FrameSim.sol";
import {QueueBitAccountImpl} from "../../src/account/QueueBitAccountImpl.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {AccountFactory} from "../../src/account/AccountFactory.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {MockToken, MockRouter, MockPQVerifier} from "./mocks/AccountMocks.sol";

/// Shared setup: one implementation + roles module, a factory-deployed proxy with a default policy, two priced
/// tokens and an allowlisted recipient. `account` and `roles` are the same proxy viewed through the two ABIs.
/// Bound mode (the production default): `vault` and `recovery` are the `PQRoleSigner` clone addresses that
/// `initialize` derived from the PQ parameters and the account's own address (not deployed: the tests act as them
/// with `vm.prank`; `BoundRoleSigners.t.sol` deploys them and signs through them). Recipient mode: Open (default).
abstract contract AccountTestBase is FrameSim {
    uint256 internal constant USD = 1e6;
    uint256 internal constant CAP = 1_000 * USD;
    uint256 internal constant PER_TX = 500 * USD;
    uint256 internal constant ETH_PRICE = 3_000 * USD;
    uint256 internal constant MAX_FEE_WEI = 0.05 ether;
    uint256 internal constant MAX_PRIO = 10 gwei;
    uint256 internal constant THRESHOLD = 2_000 * USD;
    uint48 internal constant DELAY = 48 hours;

    uint256 internal hotPk = 0xA11CE;
    uint256 internal tankPk = 0x7A4C;
    address internal hot;
    address internal tank;
    address internal vault;
    address internal recovery;
    bytes32 internal constant VAULT_PK = keccak256("queuebit.test.vault-pk");
    bytes32 internal constant RECOVERY_PK = keccak256("queuebit.test.recovery-pk");
    uint256 internal constant SIG_LEN = 64;
    address internal vaultPayer = makeAddr("vaultPayer");
    RoleSignerFactory internal signerFactory;
    MockPQVerifier internal pqVerifier;
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    QueueBitAccountRoles internal rolesModule;
    QueueBitAccountImpl internal impl;
    AccountFactory internal factory;
    QueueBitAccountImpl internal account;
    QueueBitAccountRoles internal roles;
    MockToken internal usdc;
    MockToken internal weth;
    MockRouter internal router;

    function setUp() public virtual {
        hot = vm.addr(hotPk);
        tank = vm.addr(tankPk);
        rolesModule = new QueueBitAccountRoles();
        impl = new QueueBitAccountImpl(Devnet.ERC8421_WORKSHOP, true, address(rolesModule));
        simAttach(address(impl));
        factory = new AccountFactory();
        pqVerifier = new MockPQVerifier(SIG_LEN);
        signerFactory = new RoleSignerFactory(
            Devnet.ERC8421_WORKSHOP, TxParam.MAX_COST, IStakingRegistry(makeAddr("stakingRegistry")), MAX_FEE_WEI
        );
        bytes memory init = _initData(_defaultCfg());
        address predicted = factory.predictAccount(bytes32(uint256(1)), address(impl), init);
        vault = _derivedSigner(predicted, 1, VAULT_PK, vaultPayer);
        recovery = _derivedSigner(predicted, 2, RECOVERY_PK, address(0));
        vm.label(vault, "vaultSigner");
        vm.label(recovery, "recoverySigner");
        address a = factory.createAccount(bytes32(uint256(1)), address(impl), init);
        account = QueueBitAccountImpl(payable(a));
        roles = QueueBitAccountRoles(payable(a));
        vm.label(a, "account");

        usdc = new MockToken("USDC", 6);
        weth = new MockToken("WETH", 18);
        router = new MockRouter();
        vm.startPrank(vault);
        roles.vaultSetGuardian(guardian, true);
        vm.stopPrank();
        // Loosening config through the queue, as production does.
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](3);
        c[0] = _selfCall(abi.encodeCall(QueueBitAccountRoles.vaultSetToken, (address(usdc), true, 6, 1 * USD)));
        c[1] = _selfCall(abi.encodeCall(QueueBitAccountRoles.vaultSetToken, (address(weth), true, 18, ETH_PRICE)));
        c[2] = _selfCall(abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (alice, true)));
        _queueAndExecute(c, 1);

        usdc.mint(address(account), 100_000 * USD);
        weth.mint(address(account), 100 ether);
        vm.deal(address(account), 100 ether);
        vm.deal(tank, 1 ether);
    }

    // ---------------------------------------------------------------------------------------------- helpers ------

    /// Bound mode (default): vault and recovery derived from their PQ parameters at initialize.
    function _defaultCfg() internal view returns (IQueueBitAccount.InitConfig memory c) {
        c = _explicitCfg(address(0), address(0));
        c.roleSignerFactory = address(signerFactory);
        c.vault = IQueueBitAccount.RoleSignerParams(bytes32(0), VAULT_PK, address(pqVerifier), vaultPayer);
        c.recovery = IQueueBitAccount.RoleSignerParams(bytes32(0), RECOVERY_PK, address(pqVerifier), address(0));
    }

    /// Explicit (unbound / legacy) mode: the signers by address.
    function _explicitCfg(address v, address r) internal view returns (IQueueBitAccount.InitConfig memory) {
        IQueueBitAccount.RoleSignerParams memory none;
        return IQueueBitAccount.InitConfig({
            hotKey: hot,
            roleSignerFactory: address(0),
            vault: none,
            recovery: none,
            vaultSigner: v,
            recoverySigner: r,
            tank: tank,
            capUsdPerDay: CAP,
            perTxMaxUsd: PER_TX,
            maxFeeWeiPerTx: MAX_FEE_WEI,
            maxPriorityFeePerGas: MAX_PRIO,
            maxHotFrames: 4,
            selfPay: false,
            timelockDelay: DELAY,
            timelockThresholdUsd: THRESHOLD,
            ethUsdPrice: ETH_PRICE,
            recipientMode: IQueueBitAccount.RecipientMode.Open,
            tokens: new IQueueBitAccount.TokenInit[](0)
        });
    }

    /// The bound signer `initialize` derives for `acct` (what `createRoleSigner` would deploy).
    function _derivedSigner(address acct, uint8 role, bytes32 pk, address payer) internal view returns (address) {
        return signerFactory.predictRoleSigner(bytes32(0), role, acct, pk, address(pqVerifier), payer);
    }

    /// Instant tightening to the recipient allowlist (the pre-2026-11-06 behaviour).
    function _strict() internal {
        vm.prank(vault);
        roles.vaultSetRecipientMode(IQueueBitAccount.RecipientMode.Strict);
    }

    function _initData(IQueueBitAccount.InitConfig memory c) internal pure returns (bytes memory) {
        return abi.encodeCall(QueueBitAccountImpl.initialize, (c));
    }

    function _selfCall(bytes memory data) internal view returns (IQueueBitAccount.Call memory) {
        return IQueueBitAccount.Call(address(account), 0, data);
    }

    function _one(IQueueBitAccount.Call memory c) internal pure returns (IQueueBitAccount.Call[] memory a) {
        a = new IQueueBitAccount.Call[](1);
        a[0] = c;
    }

    function _queueAndExecute(IQueueBitAccount.Call[] memory c, uint8 kind) internal returns (bytes32 opId) {
        vm.prank(vault);
        opId = roles.vaultQueue(c, kind);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        roles.executeQueued(opId, c);
    }

    function _queueLoosen(bytes memory data) internal returns (bytes32) {
        return _queueAndExecute(_one(_selfCall(data)), 1);
    }

    /// Queues a loosening self-call and expects its execution to revert (the inner call's error is wrapped).
    function _queueLoosenReverts(bytes memory data) internal {
        IQueueBitAccount.Call[] memory c = _one(_selfCall(data));
        vm.prank(vault);
        bytes32 opId = roles.vaultQueue(c, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        roles.executeQueued(opId, c);
    }

    function _usdcTransfer(address to, uint256 amount) internal view returns (IQueueBitAccount.Call memory) {
        return IQueueBitAccount.Call(address(usdc), 0, abi.encodeWithSelector(usdc.transfer.selector, to, amount));
    }

    function _ethSend(address to, uint256 amount) internal pure returns (IQueueBitAccount.Call memory) {
        return IQueueBitAccount.Call(to, amount, "");
    }

    /// Runs a hot batch as its SENDER frame would (msg.sender == account).
    function _hot(uint256 declared, IQueueBitAccount.Call[] memory calls) internal {
        vm.prank(address(account));
        account.hotExecute(declared, calls);
    }

    function _hotData(uint256 declared, IQueueBitAccount.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(QueueBitAccountImpl.hotExecute, (declared, calls));
    }

    function _verifyData() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0x4334241b)); // verifyFrame()
    }

    /// The canonical hot shape: [only_verify(account), pay(tank), SENDER(hotExecute)], signatures [hot, tank].
    function _beginHotTx(bytes memory senderData) internal {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, senderData);
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
    }

    function _signHotTx() internal {
        simSignSecp256k1(0, hotPk);
        simSignSecp256k1(1, tankPk);
    }

    function _bucketAvailable() internal view returns (uint256 a) {
        (a,,,) = account.getBucket();
    }
}

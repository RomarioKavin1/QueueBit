// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {FrameSim} from "../frame/FrameSim.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {LeakedAccountRoles} from "../../src/account/LeakedAccountRoles.sol";
import {AccountFactory} from "../../src/account/AccountFactory.sol";
import {ILeakedAccount} from "../../src/account/ILeakedAccount.sol";
import {MockToken, MockRouter} from "./mocks/AccountMocks.sol";

/// Shared setup: one implementation + roles module, a factory-deployed proxy with a default policy, two priced
/// tokens and an allowlisted recipient. `account` and `roles` are the same proxy viewed through the two ABIs.
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
    address internal vault = makeAddr("vaultSigner");
    address internal recovery = makeAddr("recoverySigner");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    LeakedAccountRoles internal rolesModule;
    LeakedAccountImpl internal impl;
    AccountFactory internal factory;
    LeakedAccountImpl internal account;
    LeakedAccountRoles internal roles;
    MockToken internal usdc;
    MockToken internal weth;
    MockRouter internal router;

    function setUp() public virtual {
        hot = vm.addr(hotPk);
        tank = vm.addr(tankPk);
        rolesModule = new LeakedAccountRoles();
        impl = new LeakedAccountImpl(Devnet.ERC8421_WORKSHOP, true, address(rolesModule));
        simAttach(address(impl));
        factory = new AccountFactory();
        address a = factory.createAccount(bytes32(uint256(1)), address(impl), _initData(_defaultCfg()));
        account = LeakedAccountImpl(payable(a));
        roles = LeakedAccountRoles(payable(a));
        vm.label(a, "account");

        usdc = new MockToken("USDC", 6);
        weth = new MockToken("WETH", 18);
        router = new MockRouter();
        vm.startPrank(vault);
        roles.vaultSetGuardian(guardian, true);
        vm.stopPrank();
        // Loosening config through the queue, as production does.
        ILeakedAccount.Call[] memory c = new ILeakedAccount.Call[](3);
        c[0] = _selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(usdc), true, 6, 1 * USD)));
        c[1] = _selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(weth), true, 18, ETH_PRICE)));
        c[2] = _selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetTarget, (alice, true)));
        _queueAndExecute(c, 1);

        usdc.mint(address(account), 100_000 * USD);
        weth.mint(address(account), 100 ether);
        vm.deal(address(account), 100 ether);
        vm.deal(tank, 1 ether);
    }

    // ---------------------------------------------------------------------------------------------- helpers ------

    function _defaultCfg() internal view returns (ILeakedAccount.InitConfig memory) {
        return ILeakedAccount.InitConfig({
            hotKey: hot,
            vaultSigner: vault,
            recoverySigner: recovery,
            tank: tank,
            capUsdPerDay: CAP,
            perTxMaxUsd: PER_TX,
            maxFeeWeiPerTx: MAX_FEE_WEI,
            maxPriorityFeePerGas: MAX_PRIO,
            maxHotFrames: 4,
            selfPay: false,
            timelockDelay: DELAY,
            timelockThresholdUsd: THRESHOLD,
            ethUsdPrice: ETH_PRICE
        });
    }

    function _initData(ILeakedAccount.InitConfig memory c) internal pure returns (bytes memory) {
        return abi.encodeCall(LeakedAccountImpl.initialize, (c));
    }

    function _selfCall(bytes memory data) internal view returns (ILeakedAccount.Call memory) {
        return ILeakedAccount.Call(address(account), 0, data);
    }

    function _one(ILeakedAccount.Call memory c) internal pure returns (ILeakedAccount.Call[] memory a) {
        a = new ILeakedAccount.Call[](1);
        a[0] = c;
    }

    function _queueAndExecute(ILeakedAccount.Call[] memory c, uint8 kind) internal returns (bytes32 opId) {
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
        ILeakedAccount.Call[] memory c = _one(_selfCall(data));
        vm.prank(vault);
        bytes32 opId = roles.vaultQueue(c, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        roles.executeQueued(opId, c);
    }

    function _usdcTransfer(address to, uint256 amount) internal view returns (ILeakedAccount.Call memory) {
        return ILeakedAccount.Call(address(usdc), 0, abi.encodeWithSelector(usdc.transfer.selector, to, amount));
    }

    function _ethSend(address to, uint256 amount) internal pure returns (ILeakedAccount.Call memory) {
        return ILeakedAccount.Call(to, amount, "");
    }

    /// Runs a hot batch as its SENDER frame would (msg.sender == account).
    function _hot(uint256 declared, ILeakedAccount.Call[] memory calls) internal {
        vm.prank(address(account));
        account.hotExecute(declared, calls);
    }

    function _hotData(uint256 declared, ILeakedAccount.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(LeakedAccountImpl.hotExecute, (declared, calls));
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

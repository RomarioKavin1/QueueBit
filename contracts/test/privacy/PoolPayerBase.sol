// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {FrameSim} from "../frame/FrameSim.sol";
import {PoolPayer} from "../../src/privacy/PoolPayer.sol";
import {PrivacyPoolsTypes} from "../../src/privacy/IPrivacyPools.sol";
import {Entrypoint} from "./vendor/privacy-pools-core/contracts/Entrypoint.sol";
import {PrivacyPoolSimple} from "./vendor/privacy-pools-core/contracts/implementations/PrivacyPoolSimple.sol";
import {IPrivacyPool} from "./vendor/privacy-pools-core/interfaces/IPrivacyPool.sol";
import {WithdrawalGroth16Verifier} from "./WithdrawalGroth16Verifier.sol";
import {PoolPayerFixtures as Fx} from "./fixtures/PoolPayerFixtures.sol";

/// Records stakes keyed on msg.sender, like the devnets' NaiveStakingRegistry.
contract MockStakingRegistry {
    mapping(address => uint256) public stakeOf;
    mapping(address => uint32) public delayOf;
    mapping(address => bool) public unlocked;

    function addStake(uint32 delay) external payable {
        stakeOf[msg.sender] += msg.value;
        delayOf[msg.sender] = delay;
    }

    function unlockStake() external {
        unlocked[msg.sender] = true;
    }

    function withdrawStake(address payable to) external {
        require(unlocked[msg.sender], "locked");
        uint256 a = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        (bool ok,) = to.call{value: a}("");
        require(ok);
    }

    function getDepositInfo(address a) external view returns (uint256, uint32, uint64) {
        return (stakeOf[a], delayOf[a], 0);
    }
}

/// A recipient whose `receive` always reverts (the griefing vector of §2.2 cause 2). It can still pull its credit.
contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }

    function claimTo(PoolPayer payer, address payable to) external {
        payer.claim(to);
    }
}

/// Deploys the real Privacy Pools v1 contracts (vendored, Apache-2.0) + PoolPayer at the addresses the proof fixtures
/// were generated for, makes two 1-ETH deposits and posts the ASP root. Frame-tx builders for the PoolPayer shape.
abstract contract PoolPayerBase is FrameSim {
    uint256 internal constant FLOAT = 10 ether;
    uint256 internal constant MAX_COST = 0.005 ether;
    uint256 internal constant GAS_PRICE = 1 gwei;
    string internal constant CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    // Frame budgets of the unit tests (the devnet values are calibrated in contracts/devnet-tests/privacy).
    uint64 internal constant PAY_GAS = 600_000;
    uint64 internal constant PAY_STATE = 200_000;
    uint64 internal constant SETTLE_GAS = 1_000_000;
    uint64 internal constant SETTLE_STATE = 600_000;
    uint64 internal constant REFUND_GAS = 100_000;
    uint64 internal constant REFUND_STATE = 200_000;

    WithdrawalGroth16Verifier internal verifier;
    Entrypoint internal entrypoint;
    PrivacyPoolSimple internal pool;
    MockStakingRegistry internal registry;
    PoolPayer internal payer;
    RevertingReceiver internal griefer;

    address internal owner = makeAddr("owner");
    address internal postman = makeAddr("postman");
    address internal operator = makeAddr("operator");
    address internal depositor = makeAddr("depositor");
    address internal sender;
    uint256 internal senderPk;
    address internal bob = makeAddr("bob");

    function _config() internal view virtual returns (PoolPayer.Config memory) {
        return PoolPayer.Config({
            devnet: Devnet.ERC8421_WORKSHOP,
            entrypoint: address(entrypoint),
            pool: address(pool),
            registry: address(registry),
            operator: operator,
            feeParam: TxParam.MAX_COST,
            intrinsicGas: 15_000,
            perFrameGas: 475,
            gasPerDataByte: 4,
            refundFrameGas: 30_000,
            valueFrameGas: 6_000,
            minPayStateGas: PAY_STATE,
            minSettleGas: SETTLE_GAS,
            minSettleStateGas: SETTLE_STATE,
            minRefundGas: REFUND_GAS,
            minRefundStateGas: REFUND_STATE
        });
    }

    /// The PoolPayer under test (`PoolPayerLite.t.sol` swaps in the cheap-VERIFY variant at the same CREATE nonce, so
    /// the fixtures' proofs, whose context binds the processooor address, stay valid).
    function _deployPayer(PoolPayer.Config memory c) internal virtual returns (PoolPayer) {
        return new PoolPayer(c);
    }

    function setUp() public virtual {
        (sender, senderPk) = makeAddrAndKey("sender");
        // Deployment order = the fixture generator's CREATE nonces (1..7 of this test contract).
        verifier = new WithdrawalGroth16Verifier();
        Entrypoint impl = new Entrypoint();
        entrypoint = Entrypoint(
            payable(new ERC1967Proxy(address(impl), abi.encodeCall(Entrypoint.initialize, (owner, postman))))
        );
        pool = new PrivacyPoolSimple(address(entrypoint), address(verifier), address(verifier));
        registry = new MockStakingRegistry();
        IERC20 asset = IERC20(pool.ASSET());
        vm.prank(owner);
        entrypoint.registerPool(asset, IPrivacyPool(address(pool)), 0, 0, 0);
        payer = _deployPayer(_config());
        griefer = new RevertingReceiver();
        assertEq(address(pool), Fx.POOL, "fixture: pool address");
        assertEq(address(payer), Fx.POOL_PAYER, "fixture: PoolPayer address");
        assertEq(address(griefer), Fx.GRIEFER, "fixture: griefer address");
        assertEq(pool.SCOPE(), Fx.SCOPE, "fixture: scope");

        simAttach(address(payer));
        vm.deal(address(payer), FLOAT);
        vm.txGasPrice(GAS_PRICE);

        vm.deal(depositor, 10 ether);
        vm.startPrank(depositor);
        entrypoint.deposit{value: Fx.NOTE_VALUE}(Fx.PRECOMMITMENT_1);
        entrypoint.deposit{value: Fx.NOTE_VALUE}(Fx.PRECOMMITMENT_2);
        vm.stopPrank();
        assertEq(pool.currentRoot(), Fx.STATE_ROOT, "fixture: state root");
        assertEq(pool.roots(Fx.STATE_ROOT_INDEX), Fx.STATE_ROOT, "fixture: root index");
        vm.prank(postman);
        entrypoint.updateRoot(Fx.ASP_ROOT, CID);
    }

    // ------------------------------------------------------------------------------------------- builders ------

    struct Shape {
        uint8 settleArg; // the verify frame index settle() is told
        bool withRefund;
        uint256 tailFrames; // SENDER frames between settle and refund
        uint64 settleGas;
        uint64 refundGas;
        uint64 payState;
        uint32 rootIndexHint;
        uint256 maxCost;
    }

    function _shape() internal pure returns (Shape memory) {
        return Shape(1, true, 0, SETTLE_GAS, REFUND_GAS, PAY_STATE, Fx.STATE_ROOT_INDEX, MAX_COST);
    }

    function _verifyData(PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p, uint32 hint)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(PoolPayer.verify, (Fx.SCOPE, w, p, hint));
    }

    /// [only_verify(sender), pay(PoolPayer.verify), DEFAULT settle(1), SENDER tail*, DEFAULT refund()]
    function _buildTx(PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p, Shape memory s)
        internal
    {
        simBegin(sender);
        simSetFees(1 gwei, 2 gwei, s.maxCost);
        simAddFrame(MODE_VERIFY, ONLY_VERIFY, address(0), 10_000, 0, 0, "");
        simAddFrame(MODE_VERIFY, PAY, address(payer), PAY_GAS, s.payState, 0, _verifyData(w, p, s.rootIndexHint));
        simAddFrame(
            MODE_DEFAULT,
            0,
            address(payer),
            s.settleGas,
            SETTLE_STATE,
            0,
            abi.encodeCall(PoolPayer.settle, (s.settleArg))
        );
        for (uint256 k; k < s.tailFrames; k++) {
            simAddFrame(MODE_SENDER, 0, makeAddr("dapp"), 50_000, 0, 0, hex"01");
        }
        if (s.withRefund) {
            simAddFrame(
                MODE_DEFAULT, 0, address(payer), s.refundGas, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ())
            );
        }
        simAddSecp256k1(address(0));
        simSignSecp256k1(0, senderPk);
    }

    function _good()
        internal
        pure
        returns (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p)
    {
        return Fx.good();
    }
}

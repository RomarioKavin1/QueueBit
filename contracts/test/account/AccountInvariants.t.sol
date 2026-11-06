// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IStakingRegistry} from "../../src/interfaces/IStakingRegistry.sol";
import {RoleSignerFactory} from "../../src/roles/RoleSignerFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountImpl} from "../../src/account/QueueBitAccountImpl.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {AccountFactory} from "../../src/account/AccountFactory.sol";
import {MockToken, MockRouter, MockPQVerifier} from "./mocks/AccountMocks.sol";

/// A contract with a state-changing fallback: an "arbitrary contract" the hot key must not call in Open mode.
contract OpenModeVictim {
    uint256 public pokes;

    fallback() external payable {
        if (msg.value == 0) pokes++;
    }

    receive() external payable {
        pokes++;
    }
}

/// Plays hot key (transfers, ETH, registered hashes, router sessions), vault, recovery, guardian, anyone, an
/// attacker and time against one account and keeps ghost state for the invariants (§10.7.1 layer 3).
contract AccountHandler is Test {
    uint256 internal constant USD = 1e6;

    QueueBitAccountImpl public account;
    QueueBitAccountRoles public roles;
    MockToken public usdc;
    MockRouter public router;
    address public recovery;
    address public guardian;
    address public alice;
    address public attacker = makeAddr("attacker");
    address[] internal vaultCandidates;

    // ---- ghosts ----
    uint256[] public hotTimes;
    uint256[] public hotUsd;
    uint256 public capMax;
    uint256 public hotWhileFrozen;
    uint256 public hotWhileBunker;
    uint256[] public vaultTimes;
    uint256[] public vaultUsd;
    uint256 public thresholdMax;
    uint256 public attackerSuccesses;
    uint256 public nonVaultLoosenings;
    uint256 public rotationTamperedByVault;
    /// Open-mode abuse that succeeded (approve / permit / transferFrom / increaseAllowance on a token, a
    /// non-transfer call or a zero-value empty call to an unallowlisted contract, ETH with calldata).
    uint256 public openAbuseSuccesses;
    /// A transfer to a recipient outside the allowlist that succeeded while the mode was Strict.
    uint256 public strictViolations;
    uint256 public openPayments;
    /// A hot payment that succeeded to a self-defeating recipient the vault never allowlisted: the account, a role
    /// signer, the token being moved, a guardian or an allowlisted token (in either mode).
    uint256 public forbiddenPayments;
    OpenModeVictim public victim = new OpenModeVictim();

    bytes32[] public ops;
    mapping(bytes32 => uint48) public ghostEta;
    mapping(bytes32 => uint256) public executions;
    mapping(bytes32 => bool) public ghostCancelled;
    mapping(bytes32 => IQueueBitAccount.Call[]) internal opCalls;

    uint256 public calls;

    constructor(QueueBitAccountImpl a, MockToken u, MockRouter r, address rec, address g, address al) {
        account = a;
        roles = QueueBitAccountRoles(payable(address(a)));
        usdc = u;
        router = r;
        (, thresholdMax,) = roles.getVaultBucket();
        recovery = rec;
        guardian = g;
        alice = al;
        vaultCandidates.push(makeAddr("vaultB"));
        vaultCandidates.push(makeAddr("vaultC"));
        (,, uint256 cap,) = a.getBucket();
        capMax = cap;
    }

    // ------------------------------------------------------------------------------------------- helpers ------

    function _vault() internal view returns (address v) {
        (v,,,,) = roles.getRoles();
    }

    function _cfg() internal view returns (IQueueBitAccount.HotConfig memory) {
        return account.getHotConfig();
    }

    function _cap() internal view returns (uint256 cap) {
        (,, cap,) = account.getBucket();
    }

    /// Compares two snapshots: did anything a hot transaction relies on get looser?
    function _loosened(
        IQueueBitAccount.HotConfig memory a,
        uint256 capA,
        IQueueBitAccount.HotConfig memory b,
        uint256 capB
    ) internal view returns (bool) {
        bool unfroze = a.hotFrozen && !b.hotFrozen && a.frozenUntil > block.timestamp;
        return capB > capA || b.perTxMaxUsd > a.perTxMaxUsd || b.maxFeeWeiPerTx > a.maxFeeWeiPerTx
            || b.maxHotFrames > a.maxHotFrames || b.maxPriorityFeePerGas > a.maxPriorityFeePerGas
            || (b.selfPay && !a.selfPay) || (a.bunker && !b.bunker) || (b.hotKey != a.hotKey && b.hotKey != address(0))
            || unfroze || b.tank != a.tank;
    }

    modifier nonVault() {
        IQueueBitAccount.HotConfig memory a = _cfg();
        uint256 capA = _cap();
        bool strictA = _strictMode();
        _;
        if (_loosened(a, capA, _cfg(), _cap()) || (strictA && !_strictMode())) nonVaultLoosenings++;
    }

    function _strictMode() internal view returns (bool) {
        return account.recipientMode() == IQueueBitAccount.RecipientMode.Strict;
    }

    modifier vaultAction() {
        (,, address p, uint48 eta,) = roles.getRoles();
        _;
        (,, address p2, uint48 eta2,) = roles.getRoles();
        if (eta != 0 && (p2 != p || eta2 != eta)) rotationTamperedByVault++;
        uint256 c = _cap();
        if (c > capMax) capMax = c;
    }

    function _track() internal {
        calls++;
    }

    // ---------------------------------------------------------------------------------------------- hot ------

    function hotTransfer(uint256 amount) external nonVault {
        _track();
        amount = bound(amount, 1, 600 * USD);
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](1);
        c[0] = IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (alice, amount)));
        _hotRun(amount, c, amount);
    }

    function hotEth(uint256 weiAmount) external nonVault {
        _track();
        weiAmount = bound(weiAmount, 1, 0.2 ether);
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](1);
        c[0] = IQueueBitAccount.Call(alice, weiAmount, "");
        uint256 usd = (weiAmount * 3_000 * USD + 1e18 - 1) / 1e18;
        _hotRun(usd, c, usd);
    }

    /// A payment to an arbitrary recipient (ETH or USDC): succeeds in Open mode (within the cap), never in Strict.
    function hotPayAnyone(uint256 amount, uint160 who, bool eth) external nonVault {
        _track();
        address to = address(uint160(bound(who, 0x10000, type(uint160).max)));
        if (to == address(account) || to == alice || to == account.getHotConfig().tank || to.code.length != 0) {
            to = makeAddr("bob");
        }
        bool strict = _strictMode();
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](1);
        uint256 usd;
        if (eth) {
            amount = bound(amount, 1, 0.2 ether);
            c[0] = IQueueBitAccount.Call(to, amount, "");
            usd = (amount * 3_000 * USD + 1e18 - 1) / 1e18;
        } else {
            amount = bound(amount, 1, 600 * USD);
            c[0] = IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (to, amount)));
            usd = amount;
        }
        if (_hotRun(usd, c, usd)) {
            openPayments++;
            if (strict) strictViolations++;
        }
    }

    /// ForbiddenRecipient, both modes: never the account, the vault or recovery signer, a guardian, the moved token
    /// or another allowlisted token (the second one comes from `InitConfig.tokens`).
    function hotForbidden(uint256 which, uint256 amount, bool eth) external nonVault {
        _track();
        address[] memory list = roles.getTokenList();
        (address v, address r,,,) = roles.getRoles();
        address[6] memory bad =
            [address(account), v, r, guardian, address(usdc), list.length > 1 ? list[1] : address(usdc)];
        address to = bad[bound(which, 0, 5)];
        if (to == address(0) || account.isTarget(to)) return;
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](1);
        uint256 usd;
        if (eth) {
            amount = bound(amount, 1, 0.2 ether);
            c[0] = IQueueBitAccount.Call(to, amount, "");
            usd = (amount * 3_000 * USD + 1e18 - 1) / 1e18;
        } else {
            amount = bound(amount, 1, 600 * USD);
            c[0] = IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (to, amount)));
            usd = amount;
        }
        if (_hotRun(usd, c, usd)) forbiddenPayments++;
    }

    /// Open mode never admits anything but a plain ETH send or a token `transfer` to an arbitrary address.
    function hotOpenAbuse(uint256 which, uint256 amount) external nonVault {
        _track();
        amount = bound(amount, 1, 600 * USD);
        which = bound(which, 0, 6);
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](1);
        if (which == 0) {
            c[0] = IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (attacker, amount)));
        } else if (which == 1) {
            c[0] = IQueueBitAccount.Call(
                address(usdc), 0, abi.encodeCall(IERC20.transferFrom, (address(account), attacker, amount))
            );
        } else if (which == 2) {
            c[0] = IQueueBitAccount.Call(
                address(usdc),
                0,
                abi.encodeWithSelector(0x39509351, attacker, amount) // increaseAllowance
            );
        } else if (which == 3) {
            // ERC-2612 permit(owner, spender, value, deadline, v, r, s)
            c[0] = IQueueBitAccount.Call(
                address(usdc),
                0,
                abi.encodeWithSelector(
                    0xd505accf, address(account), attacker, amount, block.timestamp, uint8(27), bytes32(0), bytes32(0)
                )
            );
        } else if (which == 4) {
            c[0] = IQueueBitAccount.Call(address(victim), 0, ""); // zero-value empty call: runs the fallback
        } else if (which == 5) {
            c[0] = IQueueBitAccount.Call(address(victim), 0, abi.encodeWithSignature("poke()"));
        } else {
            c[0] = IQueueBitAccount.Call(attacker, 1 wei, hex"deadbeef"); // ETH with calldata
        }
        uint256 pokes = victim.pokes();
        vm.prank(address(account));
        try account.hotExecute(amount, c) {
            openAbuseSuccesses++;
        } catch {}
        if (victim.pokes() != pokes || usdc.allowance(address(account), attacker) != 0) openAbuseSuccesses++;
    }

    function hotRegister(uint256 amount, bytes32 h) external nonVault {
        _track();
        amount = bound(amount, 1, 600 * USD);
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](1);
        c[0] = IQueueBitAccount.Call(
            address(account),
            0,
            abi.encodeCall(
                QueueBitAccountImpl.registerHash, (h, address(usdc), amount, uint48(block.timestamp + 1 days))
            )
        );
        _hotRun(amount, c, amount);
    }

    /// A session batch: approve the router, let it pull to alice or sweep to the attacker (H4: debited by delta),
    /// or leave part of the approval standing (I-6: must revert).
    function hotSession(uint256 amount, bool sweep, bool leaveApproval) external nonVault {
        _track();
        amount = bound(amount, 2, 600 * USD);
        IQueueBitAccount.Call[] memory c = new IQueueBitAccount.Call[](2);
        c[0] = IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(router), amount)));
        c[1] = IQueueBitAccount.Call(
            address(router),
            0,
            leaveApproval
                ? abi.encodeCall(MockRouter.pullPartial, (usdc, amount, sweep ? attacker : alice))
                : abi.encodeCall(MockRouter.pull, (usdc, amount, sweep ? attacker : alice))
        );
        _hotRun(amount, c, amount);
    }

    /// Runs a hot batch; on success records max(declared intent, measured USD outflow of ETH + USDC), so I-1 is
    /// checked against what actually left, whichever recipient it went to.
    function _hotRun(uint256 declared, IQueueBitAccount.Call[] memory c, uint256 usd) internal returns (bool ok) {
        IQueueBitAccount.HotConfig memory cfg = _cfg();
        uint256 eth0 = address(account).balance;
        uint256 usdc0 = usdc.balanceOf(address(account));
        vm.prank(address(account));
        try account.hotExecute(declared, c) {
            ok = true;
            if (cfg.hotFrozen) hotWhileFrozen++;
            if (cfg.bunker) hotWhileBunker++;
            uint256 out;
            if (eth0 > address(account).balance) out += ((eth0 - address(account).balance) * 3_000 * USD) / 1e18;
            if (usdc0 > usdc.balanceOf(address(account))) out += usdc0 - usdc.balanceOf(address(account));
            hotTimes.push(block.timestamp);
            hotUsd.push(out > usd ? out : usd);
        } catch {}
    }

    // -------------------------------------------------------------------------------------------- vault ------

    function vaultTighten(uint256 cap, uint256 perTx) external vaultAction {
        _track();
        IQueueBitAccount.HotConfig memory c = _cfg();
        cap = bound(cap, 0, _cap());
        perTx = bound(perTx, 0, c.perTxMaxUsd);
        vm.prank(_vault());
        try roles.vaultSetCap(cap, perTx, c.maxFeeWeiPerTx, c.maxHotFrames) {} catch {}
    }

    function vaultQueueLoosen(uint256 cap) external vaultAction {
        _track();
        cap = bound(cap, 0, 5_000 * USD);
        IQueueBitAccount.HotConfig memory c = _cfg();
        IQueueBitAccount.Call[] memory q = new IQueueBitAccount.Call[](1);
        q[0] = IQueueBitAccount.Call(
            address(account),
            0,
            abi.encodeCall(QueueBitAccountRoles.vaultSetCap, (cap, 500 * USD, c.maxFeeWeiPerTx, c.maxHotFrames))
        );
        _queue(q, 1);
    }

    function vaultQueueSpend(uint256 amount) external vaultAction {
        _track();
        amount = bound(amount, 1, 10_000 * USD);
        IQueueBitAccount.Call[] memory q = new IQueueBitAccount.Call[](1);
        q[0] = IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (alice, amount)));
        _queue(q, 0);
    }

    function _queue(IQueueBitAccount.Call[] memory q, uint8 kind) internal {
        vm.prank(_vault());
        try roles.vaultQueue(q, kind) returns (bytes32 op) {
            ops.push(op);
            ghostEta[op] = roles.getQueued(op).eta;
            for (uint256 i; i < q.length; ++i) {
                opCalls[op].push(q[i]);
            }
        } catch {}
    }

    function vaultCancel(uint256 i) external vaultAction {
        _track();
        if (ops.length == 0) return;
        bytes32 op = ops[bound(i, 0, ops.length - 1)];
        vm.prank(_vault());
        try roles.vaultCancel(op) {
            ghostCancelled[op] = true;
        } catch {}
    }

    function vaultExecuteSmall(uint256 amount) external vaultAction {
        _track();
        amount = bound(amount, 1, 3_000 * USD);
        IQueueBitAccount.Call[] memory q = new IQueueBitAccount.Call[](1);
        q[0] = IQueueBitAccount.Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (alice, amount)));
        vm.prank(_vault());
        try roles.vaultExecute(q, amount) {
            vaultTimes.push(block.timestamp);
            vaultUsd.push(amount);
        } catch {}
    }

    /// Open -> Strict is instant; Strict -> Open directly must revert (`MustQueue`), so it is queued.
    function vaultRecipientMode(bool strict) external vaultAction {
        _track();
        vm.prank(_vault());
        if (strict) {
            try roles.vaultSetRecipientMode(IQueueBitAccount.RecipientMode.Strict) {} catch {}
        } else {
            bool wasStrict = _strictMode();
            try roles.vaultSetRecipientMode(IQueueBitAccount.RecipientMode.Open) {
                if (wasStrict) nonVaultLoosenings++; // an unqueued loosening, even by the vault
            } catch {}
            IQueueBitAccount.Call[] memory q = new IQueueBitAccount.Call[](1);
            q[0] = IQueueBitAccount.Call(
                address(account),
                0,
                abi.encodeCall(QueueBitAccountRoles.vaultSetRecipientMode, (IQueueBitAccount.RecipientMode.Open))
            );
            _queue(q, 1);
        }
    }

    function vaultFreezeOrUnfreeze(bool freeze) external vaultAction {
        _track();
        vm.prank(_vault());
        if (freeze) {
            try roles.vaultFreeze() {} catch {}
        } else {
            try roles.vaultUnfreeze() {} catch {}
        }
    }

    function vaultBunkerOrRekey(bool bunker) external vaultAction {
        _track();
        vm.prank(_vault());
        if (bunker) {
            try roles.vaultEnableBunker() {} catch {}
        } else {
            try roles.vaultSetHotKey(makeAddr("hotKey2")) {} catch {}
        }
    }

    // ---------------------------------------------------------------------------------------- anyone ------

    function anyoneExecute(uint256 i) external nonVaultUnlessQueued {
        _track();
        if (ops.length == 0) return;
        bytes32 op = ops[bound(i, 0, ops.length - 1)];
        try roles.executeQueued(op, opCalls[op]) {
            executions[op]++;
        } catch {}
    }

    /// executeQueued may loosen (vault authority, after the delay); everything else of "anyone" may not.
    modifier nonVaultUnlessQueued() {
        _;
        uint256 c = _cap();
        if (c > capMax) capMax = c;
    }

    function anyoneClearFreeze() external nonVault {
        _track();
        try account.clearExpiredFreeze() {} catch {}
    }

    function anyoneFinalizeRotation() external nonVault {
        _track();
        try roles.recoveryFinalizeVaultRotation() {} catch {}
    }

    // ------------------------------------------------------------------------------- recovery / guardian ------

    function recoveryCancel(uint256 i) external nonVault {
        _track();
        if (ops.length == 0) return;
        bytes32 op = ops[bound(i, 0, ops.length - 1)];
        vm.prank(recovery);
        try roles.recoveryCancel(op) {
            ghostCancelled[op] = true;
        } catch {}
    }

    function recoveryRotate(uint256 i, bool cancel) external nonVault {
        _track();
        vm.prank(recovery);
        if (cancel) {
            try roles.recoveryCancelVaultRotation() {} catch {}
        } else {
            try roles.recoveryStartVaultRotation(vaultCandidates[bound(i, 0, 1)]) {} catch {}
        }
    }

    function guardianFreeze() external nonVault {
        _track();
        vm.prank(guardian);
        try roles.guardianFreeze() {} catch {}
    }

    // -------------------------------------------------------------------------------------- attacker ------

    function attackerConfig(uint256 which, uint256 x) external nonVault {
        _track();
        which = bound(which, 0, 8);
        bytes memory d;
        if (which == 0) {
            d = abi.encodeCall(QueueBitAccountRoles.vaultSetCap, (x, x, x, 64));
        } else if (which == 1) {
            d = abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (attacker, true));
        } else if (which == 2) {
            d = abi.encodeCall(QueueBitAccountRoles.vaultSetHotKey, (attacker));
        } else if (which == 3) {
            d = abi.encodeCall(QueueBitAccountRoles.vaultUnfreeze, ());
        } else if (which == 4) {
            d = abi.encodeCall(QueueBitAccountRoles.recoveryStartVaultRotation, (attacker));
        } else if (which == 5) {
            d = abi.encodeCall(QueueBitAccountRoles.vaultSetFeePolicy, (x, true, attacker));
        } else if (which == 6) {
            d = abi.encodeCall(QueueBitAccountImpl.hotExecute, (x, new IQueueBitAccount.Call[](0)));
        } else if (which == 8) {
            d = abi.encodeCall(
                QueueBitAccountRoles.vaultSetRecipientMode,
                (x % 2 == 0 ? IQueueBitAccount.RecipientMode.Open : IQueueBitAccount.RecipientMode.Strict)
            );
        } else {
            d = abi.encodeCall(account.upgradeToAndCall, (attacker, ""));
        }
        vm.prank(attacker);
        (bool ok,) = address(account).call(d);
        if (ok) attackerSuccesses++;
        // the hot key's EOA has no authority either (C3)
        vm.prank(makeAddr("hotKeyEOA"));
        (ok,) = address(account).call(d);
        if (ok) attackerSuccesses++;
    }

    // ------------------------------------------------------------------------------------------- time ------

    function warp(uint256 dt) external {
        _track();
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }

    // ----------------------------------------------------------------------------------------- views ------

    function hotCount() external view returns (uint256) {
        return hotTimes.length;
    }

    function vaultCount() external view returns (uint256) {
        return vaultTimes.length;
    }

    function opCount() external view returns (uint256) {
        return ops.length;
    }
}

contract AccountInvariantsTest is Test {
    uint256 internal constant USD = 1e6;
    AccountHandler internal handler;
    QueueBitAccountImpl internal account;
    QueueBitAccountRoles internal roles;

    function setUp() public {
        address recovery = makeAddr("recovery");
        address guardian = makeAddr("guardian");
        address alice = makeAddr("alice");
        QueueBitAccountRoles module = new QueueBitAccountRoles();
        QueueBitAccountImpl impl = new QueueBitAccountImpl(Devnet.ERC8421_WORKSHOP, true, address(module));
        AccountFactory factory = new AccountFactory();
        RoleSignerFactory rsf =
            new RoleSignerFactory(Devnet.ERC8421_WORKSHOP, TxParam.MAX_COST, IStakingRegistry(makeAddr("reg")), 1 ether);
        MockPQVerifier pqv = new MockPQVerifier(64);
        IQueueBitAccount.RoleSignerParams memory none;
        // The ERC-20 allowlist comes from InitConfig.tokens (USDC and a second priced token), not a queued op.
        MockToken usdc = new MockToken("USDC", 6);
        MockToken dai = new MockToken("DAI", 18);
        IQueueBitAccount.TokenInit[] memory tokens = new IQueueBitAccount.TokenInit[](2);
        tokens[0] = IQueueBitAccount.TokenInit(address(usdc), 6, 1 * USD);
        tokens[1] = IQueueBitAccount.TokenInit(address(dai), 18, 1 * USD);
        // Bound vault (derived at initialize), explicit recovery (an address; the handler pranks as it).
        IQueueBitAccount.InitConfig memory c = IQueueBitAccount.InitConfig({
            hotKey: makeAddr("hotKeyEOA"),
            roleSignerFactory: address(rsf),
            vault: IQueueBitAccount.RoleSignerParams(0, keccak256("vault"), address(pqv), makeAddr("payer")),
            recovery: none,
            vaultSigner: address(0),
            recoverySigner: recovery,
            tank: makeAddr("tank"),
            capUsdPerDay: 1_000 * USD,
            perTxMaxUsd: 500 * USD,
            maxFeeWeiPerTx: 0.05 ether,
            maxPriorityFeePerGas: 10 gwei,
            maxHotFrames: 4,
            selfPay: false,
            timelockDelay: 48 hours,
            timelockThresholdUsd: 2_000 * USD,
            ethUsdPrice: 3_000 * USD,
            recipientMode: IQueueBitAccount.RecipientMode.Open,
            tokens: tokens
        });
        account = QueueBitAccountImpl(
            payable(factory.createAccount(0, address(impl), abi.encodeCall(QueueBitAccountImpl.initialize, (c))))
        );
        roles = QueueBitAccountRoles(payable(address(account)));
        address vault =
            rsf.predictRoleSigner(0, 1, address(account), keccak256("vault"), address(pqv), makeAddr("payer"));
        (address v,,,,) = roles.getRoles();
        assertEq(v, vault, "bound vault derived at initialize");
        MockRouter router = new MockRouter();
        usdc.mint(address(account), 1e12 * USD);
        vm.deal(address(account), 1e6 ether);

        // allowlist usdc and alice, the guardian, and a router session through the queue
        uint48 sessionExpiry = uint48(block.timestamp + 365 days);
        IQueueBitAccount.Call[] memory q = new IQueueBitAccount.Call[](5);
        q[2] = IQueueBitAccount.Call(
            address(account),
            0,
            abi.encodeCall(
                QueueBitAccountRoles.vaultSetSession, (address(usdc), IERC20.approve.selector, 1e9 * USD, sessionExpiry)
            )
        );
        q[3] = IQueueBitAccount.Call(
            address(account),
            0,
            abi.encodeCall(
                QueueBitAccountRoles.vaultSetSession,
                (address(router), MockRouter.pull.selector, 1e9 * USD, sessionExpiry)
            )
        );
        q[4] = IQueueBitAccount.Call(
            address(account),
            0,
            abi.encodeCall(
                QueueBitAccountRoles.vaultSetSession,
                (address(router), MockRouter.pullPartial.selector, 1e9 * USD, sessionExpiry)
            )
        );
        q[0] = IQueueBitAccount.Call(
            address(account), 0, abi.encodeCall(QueueBitAccountRoles.vaultSetTarget, (alice, true))
        );
        q[1] = IQueueBitAccount.Call(
            address(account), 0, abi.encodeCall(QueueBitAccountRoles.vaultSetGuardian, (guardian, true))
        );
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(q, 1);
        vm.warp(block.timestamp + 48 hours);
        roles.executeQueued(op, q);

        handler = new AccountHandler(account, usdc, router, recovery, guardian, alice);
        targetContract(address(handler));
    }

    /// The session handler reaches the state the invariants are about: a full pull succeeds (and sweeps to the
    /// attacker, debited), a partial one reverts (I-6) rather than silently failing for another reason.
    function test_handler_sessionsReachable() public {
        uint256 before = handler.usdc().balanceOf(handler.attacker());
        handler.hotSession(100 * USD, true, false);
        assertEq(handler.usdc().balanceOf(handler.attacker()), before + 100 * USD);
        assertEq(handler.hotCount(), 1);
        handler.hotSession(100 * USD, true, true);
        assertEq(handler.hotCount(), 1, "partial pull must revert (I-6)");
        assertEq(handler.usdc().allowance(address(account), address(handler.router())), 0);
    }

    /// I-6: no approval granted by a hot batch survives it (the router session is the only approver).
    function invariant_noStandingApproval() public view {
        assertEq(handler.usdc().allowance(address(account), address(handler.router())), 0, "I-6 standing approval");
    }

    /// The vault's instant spends are bounded like the hot bucket: over any window, <= threshold + elapsed x
    /// threshold / 1 day (the daily instant allowance; the handler never raises it).
    function invariant_vaultInstantSpendBounded() public view {
        uint256 n = handler.vaultCount();
        uint256 cap = handler.thresholdMax();
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            uint256 ti = handler.vaultTimes(i);
            for (uint256 j = i; j < n; ++j) {
                sum += handler.vaultUsd(j);
                assertLe(sum, cap + ((handler.vaultTimes(j) - ti) * cap) / 1 days, "vault instant spend over window");
            }
        }
    }

    /// I-1: USD leaving through the hot tier over any window [t_i, t_j] <= cap + (t_j - t_i) * cap / 1 day, with
    /// cap the largest cap ever in force (loosening is only possible through the queue).
    function invariant_hotOutflowBounded() public view {
        uint256 n = handler.hotCount();
        uint256 cap = handler.capMax();
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            uint256 ti = handler.hotTimes(i);
            for (uint256 j = i; j < n; ++j) {
                sum += handler.hotUsd(j);
                uint256 elapsed = handler.hotTimes(j) - ti;
                assertLe(sum, cap + (elapsed * cap) / 1 days, "I-1 hot outflow over window");
            }
        }
    }

    /// I-2 / config: nothing but the vault (directly when tightening, or a queued op) loosens what VERIFY or the hot
    /// path relies on; attackers and the hot key's EOA never succeed at any role call.
    function invariant_configOnlyVaultOrTightening() public view {
        assertEq(handler.nonVaultLoosenings(), 0, "non-vault actor loosened config");
        assertEq(handler.attackerSuccesses(), 0, "attacker call succeeded");
    }

    /// Recipient policy: Open mode never admits approve / permit / transferFrom / increaseAllowance, a non-transfer
    /// call or a zero-value empty call to an unallowlisted contract, or ETH with calldata (the cap is I-1, which
    /// records the measured outflow of every payment, allowlisted recipient or not); Strict never pays a recipient
    /// outside the allowlist; Strict -> Open only through the queue (in `invariant_configOnlyVaultOrTightening`).
    function invariant_recipientPolicy() public view {
        assertEq(handler.openAbuseSuccesses(), 0, "Open mode admitted a non-transfer call");
        assertEq(handler.strictViolations(), 0, "Strict mode paid a non-allowlisted recipient");
        assertEq(handler.victim().pokes(), 0, "arbitrary contract's fallback ran");
        assertEq(handler.forbiddenPayments(), 0, "a hot payment reached a self-defeating recipient");
    }

    /// The initial allowlist (`InitConfig.tokens`) is in force from block one and only role paths change it.
    function test_handler_initTokensAndForbiddenReachable() public {
        address[] memory list = roles.getTokenList();
        assertEq(list.length, 2);
        assertTrue(account.getToken(list[1]).allowed);
        for (uint256 w; w < 6; ++w) {
            handler.hotForbidden(w, 5 * USD, false);
            handler.hotForbidden(w, 0.001 ether, true);
        }
        handler.vaultRecipientMode(true);
        for (uint256 w; w < 6; ++w) {
            handler.hotForbidden(w, 5 * USD, false);
        }
        assertEq(handler.forbiddenPayments(), 0);
        handler.hotTransfer(5 * USD);
        assertEq(handler.hotCount(), 1, "an allowlisted payment from the initial token list works");
    }

    /// The Open-mode handlers reach success (payments) and the mode can be tightened and re-opened.
    function test_handler_openPaymentsReachable() public {
        handler.hotPayAnyone(10 * USD, 0xb0b, false);
        handler.hotPayAnyone(0.001 ether, 0xb0b0, true);
        assertEq(handler.openPayments(), 2);
        handler.vaultRecipientMode(true);
        handler.hotPayAnyone(10 * USD, 0xb0b, false);
        assertEq(handler.openPayments(), 2, "Strict refuses the arbitrary recipient");
        for (uint256 w; w < 7; ++w) {
            handler.hotOpenAbuse(w, 5 * USD);
        }
        handler.vaultRecipientMode(false);
        for (uint256 w; w < 7; ++w) {
            handler.hotOpenAbuse(w, 5 * USD);
        }
        assertEq(handler.openAbuseSuccesses(), 0);
        assertEq(handler.nonVaultLoosenings(), 0);
    }

    /// I-4: a pending recovery rotation is never changed by a vault action.
    function invariant_recoveryPriority() public view {
        assertEq(handler.rotationTamperedByVault(), 0);
    }

    /// I-5: eta fixed at queue time; executed at most once; a cancelled op never executes; nothing before eta.
    function invariant_timelockMonotone() public view {
        uint256 n = handler.opCount();
        for (uint256 i; i < n; ++i) {
            bytes32 op = handler.ops(i);
            IQueueBitAccount.QueuedOp memory q = roles.getQueued(op);
            assertEq(q.eta, handler.ghostEta(op), "eta changed");
            assertLe(handler.executions(op), 1, "executed twice");
            if (handler.ghostCancelled(op)) {
                assertEq(handler.executions(op), 0, "cancelled op executed");
                assertEq(uint256(q.state), uint256(IQueueBitAccount.OpState.CANCELLED));
            }
            if (handler.executions(op) == 1) assertEq(uint256(q.state), uint256(IQueueBitAccount.OpState.EXECUTED));
        }
    }

    /// Frozen => no hot outflow; bunker => no hot path, no hot key, and a recovery signer exists (I-7).
    function invariant_frozenAndBunkerStopHot() public view {
        assertEq(handler.hotWhileFrozen(), 0, "hot outflow while frozen");
        assertEq(handler.hotWhileBunker(), 0, "hot outflow in bunker");
        IQueueBitAccount.HotConfig memory c = account.getHotConfig();
        if (c.bunker) {
            assertEq(c.hotKey, address(0), "I-7 bunker => no hot key");
            (, address r,,,) = roles.getRoles();
            assertTrue(r != address(0), "I-7 bunker => recovery");
        }
    }

    /// While a rotation is pending the hot tier is frozen.
    function invariant_rotationImpliesFrozen() public view {
        (,,, uint48 eta,) = roles.getRoles();
        if (eta != 0) assertTrue(account.getHotConfig().hotFrozen);
    }
}

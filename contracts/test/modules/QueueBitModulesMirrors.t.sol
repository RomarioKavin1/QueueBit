// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {Execution, PackedUserOperation} from "../../src/modules/interfaces/IERC7579Modules.sol";
import {QueueBitPolicyHook} from "../../src/modules/QueueBitPolicyHook.sol";
import {QueueBitRoleExecutor} from "../../src/modules/QueueBitRoleExecutor.sol";
import {MockToken} from "./mocks/ModuleMocks.sol";
import {QueueBitModulesBase} from "./QueueBitModulesBase.sol";

/// The account's 2026-11-06 rules, mirrored in the 7579 modules (BACKLOG "Contracts"):
/// 1. `HookInit.tokens` as the account's `InitConfig.tokens`: bounded, duplicate-free, contracts only (not the
///    account, a module or the hot key), the setter's price bounds, one `TokenConfigured` each;
/// 2. `SameRoleKey`: the recovery never holds the vault's (or a pending vault's) PQ key, at install, on a recovery
///    key change and on a vault rotation; the hot key is never the account or a QueueBit module;
/// 3. the account's `ForbiddenRecipient` set: in Open, a recipient the vault has not allowlisted is never an
///    allowlisted token contract (refused in validation) or an enabled guardian (refused in execution: the guardian
///    set is not an account-associated slot); the account, the token itself and the modules stay refused in both
///    modes (d38fa6f). Strict refuses all of them as not allowlisted.
/// Runs on every host, in Open and Strict.
abstract contract QueueBitModulesMirrorsTest is QueueBitModulesBase {
    MockToken internal dai;

    function setUp() public virtual override {
        dai = new MockToken("DAI", 18);
        super.setUp();
    }

    /// Install data with a second listed token (so an allowlisted token is a possible recipient).
    function _hookInit() internal view virtual override returns (HookInit memory c) {
        c = super._hookInit();
        TokenInit[] memory t = new TokenInit[](2);
        t[0] = c.tokens[0];
        t[1] = TokenInit(address(dai), 18, 1e6);
        c.tokens = t;
    }

    function _installHookAs(address acct, HookInit memory c) internal {
        vm.prank(acct);
        hook.onInstall(abi.encode(c));
    }

    function _installHookReverts(HookInit memory c, bytes memory err) internal {
        address acct = makeAddr("freshAccount");
        vm.prank(acct);
        vm.expectRevert(err);
        hook.onInstall(abi.encode(c));
    }

    // --------------------------------------------------------------------------------- 1. HookInit.tokens ------

    function test_install_tokens_stateAndEvents() public {
        address acct = makeAddr("freshAccount");
        vm.recordLogs();
        _installHookAs(acct, _hookInit());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != TokenConfigured.selector) continue;
            address t = address(uint160(uint256(logs[i].topics[2])));
            if (t == address(usdc) || t == address(dai)) n++;
        }
        assertEq(n, 2, "one TokenConfigured per listed token");
        address[] memory list = hook.monitoredTokens(acct);
        assertEq(list.length, 2);
        assertEq(list[0], address(usdc));
        assertEq(list[1], address(dai));
        assertEq(hook.getToken(acct, address(dai)).usdPerToken, 1e6);
        assertEq(hook.quoteUsd(acct, address(dai), 2e18), 2e6);
    }

    function test_install_tokens_rejects_duplicate() public {
        HookInit memory c = _hookInit();
        c.tokens[1] = TokenInit(address(usdc), 6, 2e6);
        _installHookReverts(c, abi.encodeWithSelector(DuplicateToken.selector, address(usdc)));
    }

    function test_install_tokens_rejects_badAddresses() public {
        address acct = makeAddr("freshAccount");
        address[6] memory bad = [address(0), makeAddr("eoa"), hotKey, acct, address(hook), address(executor)];
        for (uint256 i; i < 6; ++i) {
            HookInit memory c = _hookInit();
            c.tokens[1].token = bad[i];
            _installHookReverts(c, abi.encodeWithSelector(BadAddress.selector, bad[i]));
        }
    }

    function test_install_tokens_rejects_badPriceOrDecimals() public {
        HookInit memory c = _hookInit();
        c.tokens[1].usdPerToken = 0;
        _installHookReverts(c, abi.encodeWithSelector(BadConfig.selector));
        c = _hookInit();
        c.tokens[1].decimals = 37;
        _installHookReverts(c, abi.encodeWithSelector(BadConfig.selector));
    }

    function test_install_tokens_bounded() public {
        uint256 max = hook.MAX_TOKENS();
        HookInit memory c = _hookInit();
        c.tokens = new TokenInit[](max + 1);
        for (uint256 i; i <= max; ++i) {
            c.tokens[i] = TokenInit(address(new MockToken("T", 6)), 6, 1e6);
        }
        _installHookReverts(c, abi.encodeWithSelector(TooManyTokens.selector));
        TokenInit[] memory l = c.tokens;
        assembly ("memory-safe") {
            mstore(l, max)
        }
        _installHookAs(makeAddr("freshAccount"), c);
        assertEq(hook.monitoredTokens(makeAddr("freshAccount")).length, max);
    }

    /// Fuzz: a list over a pool of 6 tokens installs iff it has at most `MAX_TOKENS` entries and no duplicate.
    function testFuzz_install_tokens_outcome(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 0, 20));
        address[6] memory pool;
        for (uint256 i; i < 6; ++i) {
            pool[i] = address(new MockToken("P", 6));
        }
        HookInit memory c = _hookInit();
        c.tokens = new TokenInit[](n);
        bool dup;
        for (uint256 i; i < n; ++i) {
            address t = pool[uint256(keccak256(abi.encode(seed, i))) % 6];
            for (uint256 j; j < i; ++j) {
                if (c.tokens[j].token == t) dup = true;
            }
            c.tokens[i] = TokenInit(t, 6, 1 + (seed % 1e9));
        }
        address acct = makeAddr("fuzzAccount");
        vm.prank(acct);
        try hook.onInstall(abi.encode(c)) {
            assertTrue(n <= 16 && !dup, "accepted a bad list");
            assertEq(hook.monitoredTokens(acct).length, n);
        } catch {
            assertTrue(n > 16 || dup, "refused a good list");
        }
    }

    /// The listed second token is payable from the first userOp (no queued `setToken`).
    function test_install_tokens_payableAtOnce() public {
        dai.mint(account, 100e18);
        address to = _open() ? stranger : recipient;
        _submitOk(_op(_single(address(dai), 0, abi.encodeCall(IERC20.transfer, (to, 5e18)))));
        assertEq(dai.balanceOf(to), 5e18);
        (uint256 avail,,) = hook.getBucket(account);
        assertEq(avail, CAP - 5e6);
    }

    // ------------------------------------------------------------------------------------ 2. SameRoleKey ------

    function test_sameRoleKey_atInstall() public {
        ExecutorInit memory xi = _executorInit();
        xi.recoveryPk = xi.vaultPk;
        vm.prank(stranger);
        vm.expectRevert(SameRoleKey.selector);
        executor.onInstall(abi.encode(xi));
    }

    /// First recovery install (instant, from none) and a queued change: never the vault's key.
    function test_sameRoleKey_setRecoveryKey() public {
        ExecutorInit memory xi = _executorInit();
        xi.recoveryPk = bytes32(0);
        address other = makeAddr("otherAccount");
        vm.prank(other);
        executor.onInstall(abi.encode(xi));
        Call[] memory c =
            _calls1(address(executor), 0, abi.encodeCall(QueueBitRoleExecutor.setRecoveryKey, (other, vaultPk)));
        uint256 n;
        (,,,, n,,,,) = executor.getRoles(other);
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(other, n, c, 0));
        vm.expectRevert(abi.encodeWithSelector(CallFailed.selector, 0, abi.encodeWithSelector(SameRoleKey.selector)));
        executor.vaultExec(other, c, 0, n, sig);

        // Queued change on the main account.
        Call[] memory q =
            _calls1(address(executor), 0, abi.encodeCall(QueueBitRoleExecutor.setRecoveryKey, (account, vaultPk)));
        bytes32 opId = _vaultQueue(q, 1);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(CallFailed.selector, 0, abi.encodeWithSelector(SameRoleKey.selector)));
        executor.executeQueued(account, opId, q);
        (,,, bytes32 rpk,,,,,) = executor.getRoles(account);
        assertEq(rpk, recoveryPk);
    }

    function test_sameRoleKey_vaultRotation() public {
        uint256 rn = _recoveryNonce();
        bytes memory sig = _pqSign(recoveryPk, executor.hashRecoveryRotate(account, rn, recoveryPk));
        vm.expectRevert(SameRoleKey.selector);
        executor.recoveryStartVaultRotation(account, recoveryPk, rn, sig);
        // A distinct key rotates as before.
        bytes32 fresh = keccak256("fresh-vault");
        sig = _pqSign(recoveryPk, executor.hashRecoveryRotate(account, rn, fresh));
        executor.recoveryStartVaultRotation(account, fresh, rn, sig);
        assertTrue(executor.rotationPending(account));
    }

    /// Roles distinct from the hot key: the hot key is never the account or a QueueBit module (install and rotation).
    function test_hotKey_neverAModule() public {
        address[2] memory bad = [address(hook), address(executor)];
        for (uint256 i; i < 2; ++i) {
            HookInit memory c = _hookInit();
            c.hotKey = bad[i];
            _installHookReverts(c, abi.encodeWithSelector(BadAddress.selector, bad[i]));
            Call[] memory r = _hookCall(abi.encodeCall(QueueBitPolicyHook.setHotKey, (account, bad[i])));
            uint256 n = _vaultNonce();
            bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, r, 0));
            vm.expectRevert(
                abi.encodeWithSelector(CallFailed.selector, 0, abi.encodeWithSelector(BadAddress.selector, bad[i]))
            );
            executor.vaultExec(account, r, 0, n, sig);
        }
    }

    // ------------------------------------------------------------------------------ 3. ForbiddenRecipient ------

    function _usdcTo(address to, uint256 a) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (to, a));
    }

    /// An allowlisted token contract is not an everyday payee: refused in validation, both modes, ETH or `transfer`.
    function test_forbidden_allowlistedToken_validation() public {
        _expectValidationRevert(
            _op(_single(address(usdc), 0, _usdcTo(address(dai), 1e6))),
            abi.encodeWithSelector(NotAllowed.selector, address(dai), IERC20.transfer.selector)
        );
        _expectValidationRevert(
            _op(_single(address(dai), 0.01 ether, "")),
            abi.encodeWithSelector(NotAllowed.selector, address(dai), bytes4(0))
        );
    }

    /// An enabled guardian: Open refuses it in execution (preCheck), Strict in validation (not allowlisted).
    function test_forbidden_guardian() public {
        uint256 u0 = usdc.balanceOf(guardian);
        uint256 e0 = guardian.balance;
        bytes memory transferOp = _single(address(usdc), 0, _usdcTo(guardian, 1e6));
        bytes memory ethOp = _single(guardian, 0.001 ether, "");
        if (_open()) {
            _expectExecFail(
                _op(transferOp), abi.encodeWithSelector(NotAllowed.selector, guardian, IERC20.transfer.selector)
            );
            _expectExecFail(_op(ethOp), abi.encodeWithSelector(NotAllowed.selector, guardian, bytes4(0)));
        } else {
            _expectValidationRevert(
                _op(transferOp), abi.encodeWithSelector(NotAllowed.selector, guardian, IERC20.transfer.selector)
            );
        }
        assertEq(usdc.balanceOf(guardian), u0, "guardian not paid");
        assertEq(guardian.balance, e0, "guardian not paid ETH");
        // Removed as guardian: an ordinary recipient again (Open).
        _vaultExec(
            _calls1(address(executor), 0, abi.encodeCall(QueueBitRoleExecutor.setGuardian, (account, guardian, false))),
            0
        );
        if (_open()) {
            _submitOk(_op(transferOp));
            assertEq(usdc.balanceOf(guardian), u0 + 1e6);
        }
    }

    /// The vault may allowlist such a recipient explicitly (queued), as on the account: then it is payable in both
    /// modes (except `to == token`, which stays refused).
    function test_forbidden_allowlistedRecipientAdmitted() public {
        Call[] memory c = new Call[](2);
        c[0] = Call(address(hook), 0, abi.encodeCall(QueueBitPolicyHook.setTarget, (account, guardian, true)));
        c[1] = Call(address(hook), 0, abi.encodeCall(QueueBitPolicyHook.setTarget, (account, address(dai), true)));
        _queueAndRun(c, 1);
        _submitOk(_op(_single(address(usdc), 0, _usdcTo(guardian, 1e6))));
        _submitOk(_op(_single(address(usdc), 0, _usdcTo(address(dai), 1e6))));
        assertEq(usdc.balanceOf(guardian), 1e6);
        assertEq(usdc.balanceOf(address(dai)), 1e6);
        _expectValidationRevert(
            _op(_single(address(dai), 0, abi.encodeCall(IERC20.transfer, (address(dai), 1e18)))),
            abi.encodeWithSelector(NotAllowed.selector, address(dai), IERC20.transfer.selector)
        );
    }

    /// Fuzz over the forbidden set and fresh recipients: only a fresh EOA (Open) or the allowlisted recipient is paid.
    function testFuzz_forbidden_recipients(uint256 which, uint96 amount) public {
        address[7] memory to =
            [account, address(usdc), address(dai), address(hook), address(executor), guardian, makeAddr("fresh")];
        uint256 i = which % 7;
        uint256 a = bound(amount, 1, 100e6);
        uint256 before = usdc.balanceOf(to[i]);
        try this.submitExternal(_op(_single(address(usdc), 0, _usdcTo(to[i], a)))) returns (bool ok) {
            if (ok) assertTrue(i == 6 && _open(), "a forbidden recipient was paid");
        } catch {}
        if (i != 6 || !_open()) assertEq(usdc.balanceOf(to[i]), before);
    }

    function submitExternal(PackedUserOperation memory op) external returns (bool) {
        require(msg.sender == address(this));
        return _submit(op).success;
    }
}

contract QueueBitModulesMirrorsMSATest is QueueBitModulesMirrorsTest {
    function _host() internal pure override returns (Host) {
        return Host.MSA;
    }
}

contract QueueBitModulesMirrorsSafe7579Test is QueueBitModulesMirrorsTest {
    function _host() internal pure override returns (Host) {
        return Host.SAFE7579;
    }
}

contract QueueBitModulesMirrorsKernelTest is QueueBitModulesMirrorsTest {
    function _host() internal pure override returns (Host) {
        return Host.KERNEL;
    }
}

contract QueueBitModulesMirrorsMSAStrictTest is QueueBitModulesMirrorsMSATest {
    function _recipientMode() internal pure override returns (RecipientMode) {
        return RecipientMode.Strict;
    }
}

contract QueueBitModulesMirrorsSafe7579StrictTest is QueueBitModulesMirrorsSafe7579Test {
    function _recipientMode() internal pure override returns (RecipientMode) {
        return RecipientMode.Strict;
    }
}

contract QueueBitModulesMirrorsKernelStrictTest is QueueBitModulesMirrorsKernelTest {
    function _recipientMode() internal pure override returns (RecipientMode) {
        return RecipientMode.Strict;
    }
}

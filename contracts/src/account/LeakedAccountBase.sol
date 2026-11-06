// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILeakedAccount} from "./ILeakedAccount.sol";
import {LeakedAccountStorage} from "./LeakedAccountStorage.sol";

/// @title LeakedAccountBase
/// @notice Constants and internal helpers shared by `LeakedAccountImpl` (hot tier, VERIFY, 1271, UUPS) and
///         `LeakedAccountRoles` (vault / recovery / guardian surface, reached by DELEGATECALL from the
///         implementation's fallback). Both run in the proxy's context on the same ERC-7201 storage.
/// @dev Nothing here is VERIFY-reachable: `LeakedVerify` reads storage directly.
abstract contract LeakedAccountBase is ILeakedAccount {
    uint256 public constant MAX_HOT_CALLS = 8;
    uint256 public constant MAX_VAULT_CALLS = 16;
    uint256 public constant MAX_TOKENS = 16;
    uint256 public constant MAX_MIGRATE_TOKENS = 32;
    uint48 public constant GUARDIAN_FREEZE = 72 hours;
    uint48 public constant GUARDIAN_COOLDOWN = 7 days;
    uint48 public constant ROTATION_DELAY = 7 days;
    uint48 public constant DEFAULT_TIMELOCK = 48 hours;
    uint48 public constant MIN_TIMELOCK = 1 hours;
    uint48 public constant MAX_TIMELOCK = 30 days;
    uint48 public constant MAX_REGISTERED_TTL = 30 days;
    uint8 public constant DEFAULT_MAX_HOT_FRAMES = 4;

    uint8 public constant KIND_SPEND = 0;
    uint8 public constant KIND_LOOSEN = 1;
    uint8 public constant KIND_UPGRADE = 2;
    uint8 public constant KIND_MIGRATE = 3;

    // Transient slots (EIP-1153). Discarded between frames on chain; always cleared explicitly within one, because
    // a test harness (and a nested call in one frame) would otherwise see them. Never touched in VERIFY.
    bytes32 internal constant T_HOT = keccak256("leaked.account.t.hot");
    bytes32 internal constant T_HOT_DEBIT = keccak256("leaked.account.t.hotDebit");
    bytes32 internal constant T_QUEUED = keccak256("leaked.account.t.queued");
    bytes32 internal constant T_VAULT = keccak256("leaked.account.t.vault");
    bytes32 internal constant T_UPGRADE = keccak256("leaked.account.t.upgrade");

    function _s() internal pure returns (LeakedAccountStorage.Layout storage) {
        return LeakedAccountStorage.layout();
    }

    function _noActiveContext() internal view {
        if (_tload(T_HOT) != 0 || _tload(T_QUEUED) != 0 || _tload(T_VAULT) != 0) revert Reentrancy();
    }

    function _freeze(LeakedAccountStorage.Layout storage $, uint48 until) internal {
        $.hotFrozen = true;
        if (until > $.frozenUntil) $.frozenUntil = until;
        emit Frozen(msg.sender, $.frozenUntil);
    }

    function _setFeePolicy(LeakedAccountStorage.Layout storage $, uint256 maxPrio, bool selfPay, address tank)
        internal
    {
        $.maxPriorityFeePerGas = uint128(maxPrio);
        $.selfPay = selfPay;
        $.tank = tank;
        emit FeePolicyUpdated(maxPrio, selfPay, tank);
    }

    /// Recovery must be an independent key: `SameRoleKey` when the vault and the recovery hold the same PQ public key.
    /// A key not given (`0`) is read from the signer's `pk()` (a deployed `PQRoleSigner`); a counterfactual or
    /// non-PQ signer reports none and is checked by address only.
    function _checkIndependentKeys(bytes32 vaultPk, address vaultSigner, bytes32 recoveryPk, address recoverySigner)
        internal
        view
    {
        if (vaultPk == bytes32(0)) vaultPk = _rolePk(vaultSigner);
        if (recoveryPk == bytes32(0)) recoveryPk = _rolePk(recoverySigner);
        if (vaultPk != bytes32(0) && vaultPk == recoveryPk) revert SameRoleKey();
    }

    /// `signer.pk()` (`PQRoleSigner`), or 0 when it has no code or does not answer. Gas-bounded, 32 bytes copied.
    function _rolePk(address signer) internal view returns (bytes32 pk) {
        if (signer.code.length == 0) return bytes32(0);
        assembly ("memory-safe") {
            mstore(0, 0x58e14a45) // pk()
            let ok := staticcall(50000, signer, 0x1c, 4, 0, 32)
            if and(ok, gt(returndatasize(), 31)) { pk := mload(0) }
        }
    }

    function _checkCapBounds(uint256 perTxMaxUsd, uint256 maxFeeWeiPerTx, uint8 maxHotFrames) internal pure {
        if (perTxMaxUsd > type(uint96).max || maxFeeWeiPerTx > type(uint128).max) revert BadConfig();
        if (maxHotFrames < 2 || maxHotFrames > 64) revert BadConfig();
    }

    function _quote(TokenCfg storage t, uint256 amount) internal view returns (uint256) {
        return Math.mulDiv(amount, t.usdPerToken, 10 ** t.decimals, Math.Rounding.Ceil);
    }

    /// Balances of the monitored assets: [ETH, tokenList...].
    function _snapshot(LeakedAccountStorage.Layout storage $) internal view returns (uint256[] memory bals) {
        address[] storage list = $.tokenList;
        uint256 n = list.length;
        bals = new uint256[](n + 1);
        bals[0] = address(this).balance;
        for (uint256 i; i < n; ++i) {
            bals[i + 1] = _balanceOf(list[i]);
        }
    }

    /// USD value of the monitored assets that left since `before`: sum of max(0, before - now) x price. An outflow
    /// of unpriced ETH reverts: `TokenNotAllowed` in the hot context (`strict`), `MustQueue` for the vault.
    function _outflowUsd(LeakedAccountStorage.Layout storage $, uint256[] memory before, bool strict)
        internal
        view
        returns (uint256 usd)
    {
        uint256 ethNow = address(this).balance;
        if (before[0] > ethNow) {
            TokenCfg storage e = $.tokens[address(0)];
            if (!e.allowed) {
                if (strict) revert TokenNotAllowed(address(0));
                revert MustQueue();
            }
            usd += _quote(e, before[0] - ethNow);
        }
        address[] storage list = $.tokenList;
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            uint256 bal = _balanceOf(list[i]);
            if (before[i + 1] > bal) usd += _quote($.tokens[list[i]], before[i + 1] - bal);
        }
    }

    function _balanceOf(address token) internal view returns (uint256 bal) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (ok && ret.length >= 32) bal = abi.decode(ret, (uint256));
    }

    function _selector(bytes calldata data) internal pure returns (bytes4) {
        return data.length >= 4 ? bytes4(data[0:4]) : bytes4(0);
    }

    function _call(uint256 i, address target, uint256 value, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(i, ret);
    }

    function _tload(bytes32 slot) internal view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _tstore(bytes32 slot, uint256 v) internal {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }
}

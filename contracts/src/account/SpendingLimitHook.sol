// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ModuleType, ExecMode, Execution, IERC7579Hook, IERC7579Execution} from "./interfaces.sol";
import {SessionRules} from "./SessionRules.sol";

interface ISessionContext {
    function executionContext(address account) external view returns (bool allowed, bool full, bytes32 sessionKey);
}

/// ERC-7579 hook (type 4): daily ETH and token caps for session keys. VERIFY frames cannot write state, so the keystore
/// checks a session key's allowlist, per-tx caps and refused selectors at validation time, and this hook enforces and
/// records the daily caps when the account executes: ETH by call value, tokens by the amounts of ERC-20
/// transfer/transferFrom calls. Transactions signed by a full spend quorum are not limited. It also stops any tx whose
/// approval relied on an expired key (the keystore cannot read the clock in VERIFY).
contract SpendingLimitHook is IERC7579Hook {
    struct Limit {
        uint128 dailyCap; // 0 = no daily cap
        uint64 day;
        uint128 spent;
    }

    ISessionContext public immutable keystore;
    mapping(address account => bool) public installed;
    mapping(bytes32 keyId => mapping(address account => Limit)) internal _limits;
    mapping(bytes32 keyId => mapping(address token => mapping(address account => Limit))) internal _tokenLimits;

    event DailyCapSet(address indexed account, bytes32 indexed keyId, uint128 cap);
    event SessionSpend(address indexed account, bytes32 indexed keyId, uint256 amount, uint256 spentToday);
    event TokenDailyCapSet(address indexed account, bytes32 indexed keyId, address indexed token, uint128 cap);
    event SessionTokenSpend(
        address indexed account, bytes32 indexed keyId, address indexed token, uint256 amount, uint256 spentToday
    );

    error DailyCapExceeded(bytes32 keyId, uint256 spentToday, uint256 cap);
    error TokenDailyCapExceeded(bytes32 keyId, address token, uint256 spentToday, uint256 cap);
    error NotInstalled();
    error ExpiredKey();

    constructor(ISessionContext keystore_) {
        keystore = keystore_;
    }

    function isModuleType(uint256 t) external pure returns (bool) {
        return t == ModuleType.HOOK;
    }

    /// data = abi.encode(bytes32[] keyIds, uint128[] caps)
    function onInstall(bytes calldata data) external {
        installed[msg.sender] = true;
        if (data.length == 0) return;
        (bytes32[] memory ids, uint128[] memory caps) = abi.decode(data, (bytes32[], uint128[]));
        for (uint256 i; i < ids.length; ++i) {
            _setCap(msg.sender, ids[i], caps[i]);
        }
    }

    function onUninstall(bytes calldata) external {
        installed[msg.sender] = false;
    }

    function setDailyCap(bytes32 keyId, uint128 cap) external {
        if (!installed[msg.sender]) revert NotInstalled();
        _setCap(msg.sender, keyId, cap);
    }

    /// Daily cap on a session key's transfers of `token` (0 = none; the keystore's per-tx cap still applies).
    function setTokenDailyCap(bytes32 keyId, address token, uint128 cap) external {
        if (!installed[msg.sender]) revert NotInstalled();
        _tokenLimits[keyId][token][msg.sender].dailyCap = cap;
        emit TokenDailyCapSet(msg.sender, keyId, token, cap);
    }

    function limitOf(address account, bytes32 keyId) external view returns (Limit memory) {
        return _limits[keyId][account];
    }

    function tokenLimitOf(address account, bytes32 keyId, address token) external view returns (Limit memory) {
        return _tokenLimits[keyId][token][account];
    }

    function preCheck(address, uint256, bytes calldata msgData) external returns (bytes memory) {
        // Only the SENDER-frame path (execute) is limited; executors (recovery) are authorized on their own.
        if (msgData.length < 4 || bytes4(msgData[:4]) != IERC7579Execution.execute.selector) return "";
        (bool allowed, bool full, bytes32 key) = keystore.executionContext(msg.sender);
        if (!allowed) revert ExpiredKey(); // VERIFY cannot read the clock; expiry is enforced here
        if (full || key == bytes32(0)) return "";
        Execution[] memory xs = _executions(msgData[4:]);
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 total;
        for (uint256 i; i < xs.length; ++i) {
            total += xs[i].value;
            // The keystore let this session call through only if the target is a capped token (then it is a transfer).
            (bool isTransfer,, uint256 amount) = SessionRules.transferAmount(xs[i].callData);
            if (isTransfer) _spendToken(key, xs[i].target, amount, today);
        }
        Limit storage l = _limits[key][msg.sender];
        if (l.day != today) {
            l.day = today;
            l.spent = 0;
        }
        uint256 spent = uint256(l.spent) + total;
        if (l.dailyCap != 0 && spent > l.dailyCap) revert DailyCapExceeded(key, spent, l.dailyCap);
        l.spent = uint128(spent);
        emit SessionSpend(msg.sender, key, total, spent);
        return "";
    }

    function _spendToken(bytes32 key, address token, uint256 amount, uint64 today) internal {
        Limit storage t = _tokenLimits[key][token][msg.sender];
        if (t.day != today) {
            t.day = today;
            t.spent = 0;
        }
        uint256 spent = uint256(t.spent) + amount;
        if (t.dailyCap != 0 && spent > t.dailyCap) revert TokenDailyCapExceeded(key, token, spent, t.dailyCap);
        t.spent = uint128(spent);
        emit SessionTokenSpend(msg.sender, key, token, amount, spent);
    }

    function postCheck(bytes calldata) external {}

    function _setCap(address account, bytes32 keyId, uint128 cap) internal {
        _limits[keyId][account].dailyCap = cap;
        emit DailyCapSet(account, keyId, cap);
    }

    function _executions(bytes calldata args) internal pure returns (Execution[] memory xs) {
        (bytes32 mode, bytes memory ec) = abi.decode(args, (bytes32, bytes));
        if (ExecMode.callType(mode) == ExecMode.CALLTYPE_SINGLE) {
            xs = new Execution[](1);
            address target;
            uint256 value;
            assembly ("memory-safe") {
                target := shr(96, mload(add(ec, 32)))
                value := mload(add(ec, 52))
            }
            bytes memory data = new bytes(ec.length > 52 ? ec.length - 52 : 0);
            for (uint256 i; i < data.length; ++i) {
                data[i] = ec[52 + i];
            }
            xs[0] = Execution(target, value, data);
            return xs;
        }
        return abi.decode(ec, (Execution[]));
    }
}

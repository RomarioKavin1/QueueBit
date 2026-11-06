// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FrameOps, FrameHelperHub} from "./FrameOps.sol";
import {
    ModuleType,
    ApprovalMode,
    ExecMode,
    Execution,
    IERC7579Module,
    IERC7579Hook,
    IERC7579Execution,
    IFrameValidator,
    IERC8286FrameAccount
} from "./interfaces.sol";

/// LeanPool Account: an ERC-7579 modular smart account for EIP-8141 frame transactions (ERC-8286, contract-dispatched).
///
/// - VERIFY frame: `verify(abi.encode(validator, validatorData))` asks an installed frame validator (type 11) for an
///   approval mode, masks it with the frame's allowed scope, and approves execution only if every SENDER frame of the
///   transaction targets this account (ERC-8286 steps 1-7). Nothing else runs in VERIFY.
/// - SENDER frames call `execute(mode, executionCalldata)` (caller = tx.sender = this account), so every operation goes
///   through the account, its hook and its modules.
/// - Executors (type 2) call `executeFromExecutor`; one hook (type 4) wraps both execution paths.
///
/// Deployed as EIP-1167 clones of one implementation (LeanAccountFactory). Frame instructions go through the shared
/// FrameHelperHub helpers (immutables in the implementation's code), the same set the keystore uses.
contract LeanAccount is FrameOps, IERC8286FrameAccount, IERC7579Execution {
    uint8 internal constant FRAME_MODE_VERIFY = 1;
    uint8 internal constant FRAME_MODE_SENDER = 2;
    uint8 public constant EXECUTION_ROUTE_CONTRACT = 0x01;

    uint8 internal constant BIT_VALIDATOR = 1;
    uint8 internal constant BIT_EXECUTOR = 2;
    uint8 internal constant BIT_HOOK = 4;

    /// ERC-1967 implementation slot (UUPS).
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address private immutable SELF = address(this);

    /// All state lives under one ERC-7201 namespace, so the account can take over an address that already has storage:
    /// an upgradeable smart account (UUPS) or an EOA that delegated elsewhere before (EIP-7702).
    /// @custom:storage-location erc7201:leanpool.account.LeanAccount
    struct AccountStorage {
        /// One slot per module: bit 0 frame validator, bit 1 executor, bit 2 hook (a single read tells a validator
        /// whether a call targets a module).
        mapping(address => uint8) moduleBits;
        uint256 validatorCount;
        address hook;
        bool initialized;
    }

    /// keccak256(abi.encode(uint256(keccak256("leanpool.account.LeanAccount")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0x7096d49af5ef3af9fbcde8928592178e30496b12360070232ea0f009c1c27f00;

    function _s() internal pure returns (AccountStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_SLOT
        }
    }

    event TryExecuteUnsuccessful(uint256 index, bytes result);
    /// ERC-1967.
    event Upgraded(address indexed implementation);

    error AlreadyInitialized();
    error OnlySelf();
    error OnlyExecutor();
    error NotVerifyFrame();
    error NotTarget();
    error ValidatorNotInstalled();
    error ValidationFailed();
    error UnsupportedModuleType(uint256 moduleTypeId);
    error UnsupportedExecutionMode(bytes32 mode);
    error ModuleAlreadyInstalled(address module);
    error ModuleNotInstalled(address module);
    error LastValidator();
    error HookAlreadyInstalled();
    error NotProxy();
    error UUPSUnauthorizedCallContext();
    error NotUUPS();

    constructor(FrameHelperHub hub) FrameOps(hub) {
        _s().initialized = true; // the implementation itself is never an account
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    modifier withHook() {
        address hook = _s().hook;
        if (hook == address(0)) {
            _;
        } else {
            bytes memory hookData = IERC7579Hook(hook).preCheck(msg.sender, msg.value, msg.data);
            _;
            IERC7579Hook(hook).postCheck(hookData);
        }
    }

    /// Called once: by the factory in a clone's creation tx, by `upgradeToAndCall` when a UUPS account upgrades into
    /// LeanAccount, or by an EIP-7702-delegated EOA calling itself (in the same tx as its authorization). A delegated
    /// EOA (23-byte delegation designator) accepts it only from itself, so nobody can initialize it first.
    function initialize(
        address validator,
        bytes calldata validatorInit,
        address hook,
        bytes calldata hookInit,
        address[] calldata executors,
        bytes[] calldata executorInits
    ) external {
        AccountStorage storage $ = _s();
        if ($.initialized) revert AlreadyInitialized();
        if (address(this).code.length == 23 && msg.sender != address(this)) revert OnlySelf();
        $.initialized = true;
        _install(ModuleType.FRAME_VALIDATOR, validator, validatorInit);
        if (hook != address(0)) _install(ModuleType.HOOK, hook, hookInit);
        for (uint256 i; i < executors.length; ++i) {
            _install(ModuleType.EXECUTOR, executors[i], executorInits[i]);
        }
    }

    // ------------------------------------------------------------------------------------------ ERC-8286 ----------

    /// The VERIFY frame's call. `data = abi.encode(validator, validatorData)`.
    function verify(bytes calldata data) external returns (uint8 approvalMode) {
        // 1. this frame, its mode and allowed scope
        uint256 fi = _txparam(TX_CURRENT_FRAME);
        if (_frameparam(fi, FP_MODE) != FRAME_MODE_VERIFY) revert NotVerifyFrame();
        if (address(uint160(_frameparam(fi, FP_TARGET))) != address(this)) revert NotTarget();
        uint8 allowed = uint8(_frameparam(fi, FP_ALLOWED_SCOPE)) & ApprovalMode.SCOPE_MASK;

        // 2-3. an installed frame validator, its result masked by the allowed scope
        (address validator, bytes memory validatorData) = abi.decode(data, (address, bytes));
        if (_s().moduleBits[validator] & BIT_VALIDATOR == 0) revert ValidatorNotInstalled();
        approvalMode = IFrameValidator(validator).validateFrame(validatorData) & allowed;

        // 4-5. execution only if every SENDER frame targets this account (contract-dispatched route); every frame
        // mode (single/batch x atomic/try) is supported, so the mode check reduces to the target check.
        if (approvalMode & ApprovalMode.EXECUTION != 0 && !_allSenderFramesTargetSelf()) {
            approvalMode &= ApprovalMode.PAYMENT;
        }

        // 6-7.
        if (approvalMode == ApprovalMode.NONE) revert ValidationFailed();
        _approve(approvalMode);
    }

    function supportsApprovalMode(uint8 approvalMode) external pure returns (bool) {
        return approvalMode >= ApprovalMode.PAYMENT && approvalMode <= ApprovalMode.EXECUTION_AND_PAYMENT;
    }

    function executionRoute() external pure returns (uint8) {
        return EXECUTION_ROUTE_CONTRACT;
    }

    function _allSenderFramesTargetSelf() internal view returns (bool) {
        uint256 n = _txparam(TX_FRAME_COUNT);
        for (uint256 i; i < n; ++i) {
            if (_frameparam(i, FP_MODE) != FRAME_MODE_SENDER) continue;
            if (address(uint160(_frameparam(i, FP_TARGET))) != address(this)) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------------------------------ ERC-7579 execution --

    /// SENDER frames land here: the protocol calls with caller = tx.sender, i.e. this account.
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable onlySelf withHook {
        _execute(mode, executionCalldata);
    }

    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        withHook
        returns (bytes[] memory returnData)
    {
        if (_s().moduleBits[msg.sender] & BIT_EXECUTOR == 0) revert OnlyExecutor();
        return _execute(mode, executionCalldata);
    }

    function _execute(bytes32 mode, bytes calldata ec) internal returns (bytes[] memory results) {
        bytes1 ct = ExecMode.callType(mode);
        bytes1 et = ExecMode.execType(mode);
        if (et != ExecMode.EXECTYPE_DEFAULT && et != ExecMode.EXECTYPE_TRY) revert UnsupportedExecutionMode(mode);
        if (ct == ExecMode.CALLTYPE_SINGLE) {
            (address target, uint256 value, bytes calldata callData) = decodeSingle(ec);
            results = new bytes[](1);
            results[0] = _call(0, target, value, callData, et == ExecMode.EXECTYPE_TRY);
        } else if (ct == ExecMode.CALLTYPE_BATCH) {
            Execution[] memory batch = abi.decode(ec, (Execution[]));
            results = new bytes[](batch.length);
            for (uint256 i; i < batch.length; ++i) {
                results[i] =
                    _callMem(i, batch[i].target, batch[i].value, batch[i].callData, et == ExecMode.EXECTYPE_TRY);
            }
        } else {
            revert UnsupportedExecutionMode(mode);
        }
    }

    /// ERC-7579 single execution calldata: `abi.encodePacked(target, value, callData)`.
    function decodeSingle(bytes calldata ec)
        internal
        pure
        returns (address target, uint256 value, bytes calldata callData)
    {
        target = address(bytes20(ec[0:20]));
        value = uint256(bytes32(ec[20:52]));
        callData = ec[52:];
    }

    function _call(uint256 i, address target, uint256 value, bytes calldata data, bool tryMode)
        internal
        returns (bytes memory ret)
    {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        _handle(i, ok, ret, tryMode);
    }

    function _callMem(uint256 i, address target, uint256 value, bytes memory data, bool tryMode)
        internal
        returns (bytes memory ret)
    {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        _handle(i, ok, ret, tryMode);
    }

    function _handle(uint256 i, bool ok, bytes memory ret, bool tryMode) internal {
        if (ok) return;
        if (tryMode) {
            emit TryExecuteUnsuccessful(i, ret);
            return;
        }
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }

    // ------------------------------------------------------------------------------------------ ERC-7579 config ----

    function accountId() external pure returns (string memory) {
        return "leanpool.leanaccount.1.0.0";
    }

    function supportsModule(uint256 t) public pure returns (bool) {
        return t == ModuleType.FRAME_VALIDATOR || t == ModuleType.EXECUTOR || t == ModuleType.HOOK;
    }

    function supportsExecutionMode(bytes32 mode) external pure returns (bool) {
        bytes1 ct = ExecMode.callType(mode);
        bytes1 et = ExecMode.execType(mode);
        if (mode & bytes32(uint256(type(uint240).max)) != 0) return false; // no mode selector or payload
        if (et != ExecMode.EXECTYPE_DEFAULT && et != ExecMode.EXECTYPE_TRY) return false;
        return ct == ExecMode.CALLTYPE_SINGLE || ct == ExecMode.CALLTYPE_BATCH || ct == ExecMode.CALLTYPE_FRAME_SINGLE
            || ct == ExecMode.CALLTYPE_FRAME_BATCH;
    }

    function installModule(uint256 t, address module, bytes calldata initData) external payable onlySelf {
        _install(t, module, initData);
    }

    function uninstallModule(uint256 t, address module, bytes calldata deInitData) external payable onlySelf {
        AccountStorage storage $ = _s();
        uint8 bit = _bit(t);
        if ($.moduleBits[module] & bit == 0) revert ModuleNotInstalled(module);
        if (bit == BIT_VALIDATOR) {
            if ($.validatorCount == 1) revert LastValidator();
            $.validatorCount -= 1;
        }
        if (bit == BIT_HOOK) $.hook = address(0);
        $.moduleBits[module] &= ~bit;
        IERC7579Module(module).onUninstall(deInitData);
        emit ModuleUninstalled(t, module);
    }

    function isModuleInstalled(uint256 t, address module, bytes calldata) external view returns (bool) {
        if (!supportsModule(t)) return false;
        return _s().moduleBits[module] & _bit(t) != 0;
    }

    /// True for any installed module: frame validators read it to treat calls to modules as admin actions.
    function isAnyModule(address module) external view returns (bool) {
        return _s().moduleBits[module] != 0;
    }

    function _bit(uint256 t) internal pure returns (uint8) {
        if (t == ModuleType.FRAME_VALIDATOR) return BIT_VALIDATOR;
        if (t == ModuleType.EXECUTOR) return BIT_EXECUTOR;
        if (t == ModuleType.HOOK) return BIT_HOOK;
        revert UnsupportedModuleType(t);
    }

    function _install(uint256 t, address module, bytes calldata initData) internal {
        if (!supportsModule(t) || !IERC7579Module(module).isModuleType(t)) revert UnsupportedModuleType(t);
        AccountStorage storage $ = _s();
        uint8 bit = _bit(t);
        if ($.moduleBits[module] & bit != 0) revert ModuleAlreadyInstalled(module);
        if (bit == BIT_HOOK) {
            if ($.hook != address(0)) revert HookAlreadyInstalled();
            $.hook = module;
        }
        if (bit == BIT_VALIDATOR) $.validatorCount += 1;
        $.moduleBits[module] |= bit;
        IERC7579Module(module).onInstall(initData);
        emit ModuleInstalled(t, module);
    }

    // ------------------------------------------------------------------------------------------ upgrades (UUPS) ---

    /// ERC-1822: lets a UUPS account (OpenZeppelin-style check) upgrade into LeanAccount. Only on the implementation.
    function proxiableUUID() external view returns (bytes32) {
        if (address(this) != SELF) revert UUPSUnauthorizedCallContext();
        return IMPLEMENTATION_SLOT;
    }

    /// For an account that lives behind an ERC-1967 proxy (it upgraded into LeanAccount). An admin action: it is only
    /// reachable from the account itself, through execute, so the keystore's admin policy applies. Clones and
    /// 7702-delegated EOAs have no implementation slot pointing here and cannot use it.
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable onlySelf {
        address current;
        assembly ("memory-safe") {
            current := sload(IMPLEMENTATION_SLOT)
        }
        if (address(this) == SELF || current != SELF) revert NotProxy();
        bytes32 uuid;
        if (newImplementation.code.length != 0) {
            try LeanAccount(payable(newImplementation)).proxiableUUID() returns (bytes32 u) {
                uuid = u;
            } catch {}
        }
        if (uuid != IMPLEMENTATION_SLOT) revert NotUUPS();
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, newImplementation)
        }
        emit Upgraded(newImplementation);
        if (data.length > 0) {
            (bool ok, bytes memory ret) = newImplementation.delegatecall(data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------------ receiving ---------

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x150b7a02 // ERC721TokenReceiver
            || id == 0x4e2312e0; // ERC1155TokenReceiver
    }
}

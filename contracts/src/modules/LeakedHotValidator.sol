// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC7739Utils} from "@openzeppelin/contracts/utils/cryptography/draft-ERC7739Utils.sol";
import {
    IERC7579Validator,
    PackedUserOperation,
    Execution,
    MODULE_TYPE_VALIDATOR,
    VALIDATION_SUCCESS,
    VALIDATION_FAILED,
    ERC1271_MAGIC,
    ERC1271_INVALID
} from "./interfaces/IERC7579Modules.sol";
import {ILeakedModules, HOST_KERNEL, HOST_SAFE} from "./interfaces/ILeakedModules.sol";
import {LeakedExecDecoder} from "./lib/LeakedExecDecoder.sol";
import {LeakedPolicyHook} from "./LeakedPolicyHook.sol";

/// What the validator asks the host account (all views; in validation only the account's own storage is read).
interface IHostView {
    /// ERC-7579: global-hook hosts (reference MSA, Safe7579) answer for type 4.
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);
    /// Kernel v3: `validationConfig(bytes21 vId)` returns `(uint32 nonce, IHook hook)`; the hook is bound per validator.
    function validationConfig(bytes21 vId) external view returns (uint32 nonce, address hook);
    /// Safe v1.x: its EIP-712 domain (also the domain of Safe7579's `EmergencyUninstall`).
    function domainSeparator() external view returns (bytes32);
    /// EIP-5267.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
}

/// @title LeakedHotValidator
/// @notice ERC-7579 validator (type 1) for the everyday ("hot") key of a LEAKED account on ERC-4337 (plan
///         `10-contracts.md` §10.4.2). Stateless: the policy lives in `HOOK` (`LeakedPolicyHook`), and every slot
///         read during validation is account-associated there ([STO-021]).
///
///         `validateUserOp` (ERC-4337 validation; no TIMESTAMP/NUMBER/BALANCE, [OP-011]) checks, in this order:
///         1. the hot tier is on (installed, not bunkered, hot key set);
///         2. ECDSA over `userOpHash` (EntryPoint v0.8: an EIP-712 digest) recovers the hot key, else returns
///            `VALIDATION_FAILED` without reverting;
///         3. the account-paid prefund is bounded: sum of gas limits x maxFeePerGas <= `maxFeeWei` and
///            maxPriorityFeePerGas <= the priority bound (H3; skipped when a paymaster pays);
///         3b. the hook is still bound to the account on the host (`isModuleInstalled(4)`; Kernel: the root
///            validator's config). Whatever removes the hook (Safe7579's emergency exit, a host upgrade, a
///            misconfigured owner path) turns the hot tier off instead of leaving it uncapped;
///         4. `callData` is `execute(single|batch, default)` (optionally behind `executeUserOp`, as Kernel needs),
///            canonically encoded, and every call is one the hot tier may make (`HOOK.checkHotCalls`): allowlisted
///            ETH sends and ERC-20 transfers, an unexpired-or-not-yet-checked session, `registerHash`; while frozen,
///            only the clear-freeze batch;
///         5. the batch's static USD value <= `perTxMaxUsd` and <= the daily cap (M-b: over-cap batches are rejected
///            before they cost gas; the rolling bucket itself needs the clock and is checked in `postCheck`).
///         Policy violations revert with the reason (EntryPoint: AA23).
///
///         `isValidSignatureWithSender` is the account's scoped ERC-1271, as in the frame-native account (§10.3.2,
///         after audit fixes C1/H1). What the hot key may sign is bounded by who asks (`sender`), the "hot verifier
///         rule" (`HOOK.hotVerifierAllowed`): a code-less caller (eth_call verification) or a vault-trusted
///         verifier, never an allowlisted token or a denied value verifier (Permit2 by default). Then:
///         1. a hash registered by a hot batch, unexpired: valid with an empty signature or the 36-byte marker
///            `REGISTERED_MARKER ‖ hash`; an opaque `registerHash` hash only for `sender == address(0)` (a plain
///            eth_call) or a vault-trusted verifier (`HOOK.registeredHashAllowed`: hosts consume 1271 in
///            state-changing paths with the original caller as sender, and "code-less" includes an EOA's
///            transaction and a contract under construction, audit A1/A6); a `registerPermit` hash for its token
///            alone (the one caller whose value was bound and debited);
///         2. ERC-7739 nested typed data / personal sign by the hot key, for any app domain **except the account's
///            own** (Safe `domainSeparator()`, EIP-5267): that is the domain of host admin actions such as
///            Safe7579's `EmergencyUninstall`, which must stay vault-only (audit A1b);
///         3. the ERC-7739 support sentinel, for anyone. Nothing else is valid while frozen or bunkered, and nothing
///            at all on Kernel (`HOST_KERNEL`): Kernel rewraps every hash in its own domain, so no app hash can
///            match legitimately while a hot key could register or sign the wrapped one (audit A3).
///         The ERC-7739 "account domain" is this module's (name "LeakedHotValidator", version "1") with
///         `verifyingContract = account`: the reference MSA and Safe7579 do not implement ERC-5267.
contract LeakedHotValidator is IERC7579Validator, ILeakedModules {
    using MessageHashUtils for bytes32;
    using ERC7739Utils for *;

    /// ERC-1271 marker for a registered hash (same value as the frame-native account's).
    bytes4 public constant REGISTERED_MARKER = 0xdc6b87c9; // bytes4(keccak256("leaked.account.registeredHash"))

    bytes32 private constant SENTINEL_7739 = 0x7739773977397739773977397739773977397739773977397739773977397739;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("LeakedHotValidator");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// Kernel v3 `ValidationId` of this validator: type 0x01 ‖ address.
    bytes1 private constant KERNEL_VALIDATION_TYPE_VALIDATOR = 0x01;

    LeakedPolicyHook public immutable HOOK;

    constructor(LeakedPolicyHook hook) {
        if (address(hook).code.length == 0) revert BadAddress(address(hook));
        HOOK = hook;
    }

    // ---------------------------------------------------------------------------------------- ERC-7579 ------

    /// Nothing to store: the hot key and policy are installed with the hook.
    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isInitialized(address account) external view returns (bool) {
        return HOOK.isInitialized(account);
    }

    // ---------------------------------------------------------------------------------------- ERC-4337 ------

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external view returns (uint256) {
        address account = userOp.sender;
        HotView memory v = HOOK.hotView(account);
        if (!v.initialized || v.bunker || v.hotKey == address(0)) revert HotDisabled();

        if (account != msg.sender || userOp.signature.length != 65) return VALIDATION_FAILED;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(userOpHash, userOp.signature);
        if (err != ECDSA.RecoverError.NoError || signer != v.hotKey) return VALIDATION_FAILED;

        if (!_hookBound(account, v.host)) revert HookNotInstalled();
        _checkFees(userOp, v);

        Execution[] memory execs = LeakedExecDecoder.decodeUserOpCallData(userOp.callData);
        uint256 usd = HOOK.checkHotCalls(account, execs);
        if (usd > v.perTxMaxUsd) revert PerTxMaxExceeded(usd, v.perTxMaxUsd);
        if (usd > v.capUsdPerDay) revert OverDailyCap(usd, v.capUsdPerDay);
        return VALIDATION_SUCCESS;
    }

    // ---------------------------------------------------------------------------------------- ERC-1271 ------

    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        // ERC-7739 support detection; answered whatever the state (it authorises nothing).
        if (hash == SENTINEL_7739 && signature.length == 0) return bytes4(0x77390001);
        address account = msg.sender;
        HotView memory v = HOOK.hotView(account);
        if (!v.initialized || v.bunker || v.frozen || v.hotKey == address(0) || v.host == HOST_KERNEL) {
            return ERC1271_INVALID;
        }
        if (_isRegisteredMarker(hash, signature) && HOOK.isRegistered(account, hash)) {
            address only = HOOK.registeredHashConsumer(account, hash);
            if (only == address(0) ? HOOK.registeredHashAllowed(account, sender) : sender == only) return ERC1271_MAGIC;
        }
        if (!HOOK.hotVerifierAllowed(account, sender)) return ERC1271_INVALID;
        if (_isValidNestedTypedData(account, v.hotKey, v.host, hash, signature)) return ERC1271_MAGIC;
        if (_isValidNestedPersonalSign(account, v.hotKey, hash, signature)) return ERC1271_MAGIC;
        return ERC1271_INVALID;
    }

    /// The ERC-7739 account domain separator this module uses for `account`.
    function accountDomainSeparator(address account) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, account));
    }

    /// @notice The host account's own EIP-712 domain separator (Safe `domainSeparator()`, else EIP-5267), or 0 if
    ///         it has none. Hot-key ERC-7739 typed data is never honoured in this domain.
    function hostDomainSeparator(address account, uint8 host) public view returns (bytes32) {
        if (host == HOST_SAFE) {
            (bool ok, bytes memory ret) = account.staticcall(abi.encodeCall(IHostView.domainSeparator, ()));
            return ok && ret.length == 32 ? abi.decode(ret, (bytes32)) : bytes32(0);
        }
        (bool ok5267, bytes memory r) = account.staticcall(abi.encodeCall(IHostView.eip712Domain, ()));
        if (!ok5267 || r.length < 7 * 32) return bytes32(0);
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address vc, bytes32 salt,) =
            abi.decode(r, (bytes1, string, string, uint256, address, bytes32, uint256[]));
        return _eip712Separator(fields, name, version, chainId, vc, salt);
    }

    /// @notice Whether the policy hook is still bound to `account` on its host (read in validation: the account's
    ///         own storage only). Global-hook hosts answer `isModuleInstalled(4, hook)`; Kernel binds hooks per
    ///         validator, so the root validator's config is read (`validationConfig(0x01 ‖ this)`).
    function hookBound(address account) external view returns (bool) {
        return _hookBound(account, HOOK.hostOf(account));
    }

    // --------------------------------------------------------------------------------------- internals ------

    function _hookBound(address account, uint8 host) internal view returns (bool) {
        bool ok;
        bytes memory ret;
        if (host == HOST_KERNEL) {
            bytes21 vId = bytes21(abi.encodePacked(KERNEL_VALIDATION_TYPE_VALIDATOR, address(this)));
            (ok, ret) = account.staticcall(abi.encodeCall(IHostView.validationConfig, (vId)));
            if (!ok || ret.length != 64) return false;
            (, address bound) = abi.decode(ret, (uint32, address));
            return bound == address(HOOK);
        }
        (ok, ret) = account.staticcall(abi.encodeCall(IHostView.isModuleInstalled, (4, address(HOOK), "")));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    /// EIP-712 domain separator from EIP-5267 fields (bit i set => field i is part of the domain type).
    function _eip712Separator(
        bytes1 fields,
        string memory name,
        string memory version,
        uint256 chainId,
        address vc,
        bytes32 salt
    ) internal pure returns (bytes32) {
        bytes memory typeStr = "EIP712Domain(";
        bytes memory enc;
        if (fields & 0x01 != 0) {
            typeStr = bytes.concat(typeStr, "string name,");
            enc = bytes.concat(enc, keccak256(bytes(name)));
        }
        if (fields & 0x02 != 0) {
            typeStr = bytes.concat(typeStr, "string version,");
            enc = bytes.concat(enc, keccak256(bytes(version)));
        }
        if (fields & 0x04 != 0) {
            typeStr = bytes.concat(typeStr, "uint256 chainId,");
            enc = bytes.concat(enc, bytes32(chainId));
        }
        if (fields & 0x08 != 0) {
            typeStr = bytes.concat(typeStr, "address verifyingContract,");
            enc = bytes.concat(enc, bytes32(uint256(uint160(vc))));
        }
        if (fields & 0x10 != 0) {
            typeStr = bytes.concat(typeStr, "bytes32 salt,");
            enc = bytes.concat(enc, salt);
        }
        if (typeStr[typeStr.length - 1] == ",") typeStr[typeStr.length - 1] = ")";
        else typeStr = bytes.concat(typeStr, ")");
        return keccak256(bytes.concat(keccak256(typeStr), enc));
    }

    /// H3: the most this op can draw from the account's own ETH (no paymaster) is bounded by the policy.
    function _checkFees(PackedUserOperation calldata op, HotView memory v) internal pure {
        if (op.paymasterAndData.length != 0) return;
        uint256 verificationGas = uint128(bytes16(op.accountGasLimits));
        uint256 callGas = uint128(uint256(op.accountGasLimits));
        uint256 maxPrio = uint128(bytes16(op.gasFees));
        uint256 maxFee = uint128(uint256(op.gasFees));
        if (maxPrio > v.maxPriorityFeePerGas) revert FeeTooHigh();
        if ((verificationGas + callGas + op.preVerificationGas) * maxFee > v.maxFeeWei) revert FeeTooHigh();
    }

    function _isRegisteredMarker(bytes32 hash, bytes calldata signature) private pure returns (bool) {
        if (signature.length == 0) return true;
        return signature.length == 36 && bytes4(signature[0:4]) == REGISTERED_MARKER && bytes32(signature[4:36]) == hash;
    }

    function _isValidNestedPersonalSign(address account, address hotKey, bytes32 hash, bytes calldata signature)
        private
        view
        returns (bool)
    {
        return
            _recovers(accountDomainSeparator(account).toTypedDataHash(hash.personalSignStructHash()), signature, hotKey);
    }

    function _isValidNestedTypedData(address account, address hotKey, uint8 host, bytes32 hash, bytes calldata encoded)
        private
        view
        returns (bool)
    {
        (bytes calldata sig, bytes32 appSeparator, bytes32 contentsHash, string calldata contentsDescr) =
            encoded.decodeTypedDataSig();
        (string calldata contentsName, string calldata contentsType) = contentsDescr.decodeContentsDescr();
        if (bytes(contentsName).length == 0 || hash != appSeparator.toTypedDataHash(contentsHash)) return false;
        // The account's own domain is for its admin actions (Safe7579 `EmergencyUninstall`): never the hot key's.
        if (appSeparator == hostDomainSeparator(account, host)) return false;
        bytes memory domainBytes = abi.encode(NAME_HASH, VERSION_HASH, block.chainid, account, bytes32(0));
        return _recovers(
            appSeparator.toTypedDataHash(
                ERC7739Utils.typedDataSignStructHash(contentsName, contentsType, contentsHash, domainBytes)
            ),
            sig,
            hotKey
        );
    }

    function _recovers(bytes32 digest, bytes calldata sig, address expected) private pure returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        return err == ECDSA.RecoverError.NoError && signer == expected;
    }
}

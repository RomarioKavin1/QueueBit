// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// The Permit2 views the typed registrations read (canonical Uniswap Permit2, `AllowanceTransfer` and
/// `SignatureTransfer`).
interface IPermit2Views {
    /// `allowance[owner][token][spender]` = (amount, expiration, nonce).
    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48);
    /// Unordered nonces of `SignatureTransfer`: bit `nonce & 0xff` of word `nonce >> 8`.
    function nonceBitmap(address owner, uint256 wordPos) external view returns (uint256);
}

/// The EIP-3009 view the typed registration reads.
interface IERC3009Views {
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title TypedPermits
/// @notice On-chain EIP-712 digests of the value-moving signatures the hot tier may pre-authorise for ERC-1271
///         (`registerPermit`, `registerPermit2`, `registerPermit2Transfer`, `registerTransferAuthorization`; the
///         account and `LeakedPolicyHook` both use this library). Audit C1: the account never honours an opaque hash
///         for a token or Permit2, so every digest a token or Permit2 may consume is computed here from its typed
///         fields, and the debit is the typed amount.
/// @dev Type strings and domain are copied from the canonical sources and checked in `test/account/TypedPermits.t.sol`:
///      Permit2 `src/libraries/PermitHash.sol` (`_PERMIT_DETAILS_TYPEHASH`, `_PERMIT_SINGLE_TYPEHASH`,
///      `_TOKEN_PERMISSIONS_TYPEHASH`, `_PERMIT_TRANSFER_FROM_TYPEHASH`) and `src/EIP712.sol` (domain
///      `EIP712Domain(string name,uint256 chainId,address verifyingContract)`, name "Permit2", no version); EIP-3009
///      (`TransferWithAuthorization`, `ReceiveWithAuthorization`, the token's own `DOMAIN_SEPARATOR()`).
library TypedPermits {
    /// Canonical Permit2 (same address on every chain where it is deployed).
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 internal constant PERMIT2_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PERMIT2_NAME_HASH = keccak256("Permit2");
    bytes32 internal constant PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 internal constant PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 internal constant ERC2612_PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// Permit2's domain separator, computed (not read from the contract): `keccak256(abi.encode(typeHash,
    /// keccak256("Permit2"), chainid, PERMIT2))`.
    function permit2DomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, PERMIT2_NAME_HASH, block.chainid, PERMIT2));
    }

    /// `AllowanceTransfer.permit(owner, PermitSingle, sig)` digest for `owner`, at `owner`'s current nonce for
    /// `(token, spender)` (read from Permit2: a stale or future nonce is never registered).
    function permitSingleDigest(
        address owner,
        address token,
        uint160 amount,
        uint48 expiration,
        address spender,
        uint256 sigDeadline
    ) internal view returns (bytes32) {
        (,, uint48 nonce) = IPermit2Views(PERMIT2).allowance(owner, token, spender);
        bytes32 details = keccak256(abi.encode(PERMIT_DETAILS_TYPEHASH, token, amount, expiration, nonce));
        return MessageHashUtils.toTypedDataHash(
            permit2DomainSeparator(), keccak256(abi.encode(PERMIT_SINGLE_TYPEHASH, details, spender, sigDeadline))
        );
    }

    /// `SignatureTransfer.permitTransferFrom(permit, details, owner, sig)` digest. Permit2 hashes its own
    /// `msg.sender` as the spender, so only `spender` calling Permit2 reproduces it.
    function permitTransferFromDigest(address token, uint256 amount, address spender, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 permitted = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount));
        return MessageHashUtils.toTypedDataHash(
            permit2DomainSeparator(),
            keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, permitted, spender, nonce, deadline))
        );
    }

    /// Whether `owner`'s unordered Permit2 nonce is already spent.
    function permit2NonceUsed(address owner, uint256 nonce) internal view returns (bool) {
        return IPermit2Views(PERMIT2).nonceBitmap(owner, nonce >> 8) & (1 << (nonce & 0xff)) != 0;
    }

    /// ERC-2612 `permit` digest for `owner` at the token's current `nonces(owner)`.
    function erc2612Digest(address token, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return MessageHashUtils.toTypedDataHash(
            IERC20Permit(token).DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(ERC2612_PERMIT_TYPEHASH, owner, spender, value, IERC20Permit(token).nonces(owner), deadline)
            )
        );
    }

    /// EIP-3009 `transferWithAuthorization` (or, `receiveAuth`, `receiveWithAuthorization`) digest from `from`.
    function authorizationDigest(
        address token,
        bool receiveAuth,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 typeHash = receiveAuth ? RECEIVE_WITH_AUTHORIZATION_TYPEHASH : TRANSFER_WITH_AUTHORIZATION_TYPEHASH;
        return MessageHashUtils.toTypedDataHash(
            IERC20Permit(token).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce))
        );
    }

    function authorizationUsed(address token, address from, bytes32 nonce) internal view returns (bool) {
        return IERC3009Views(token).authorizationState(from, nonce);
    }
}

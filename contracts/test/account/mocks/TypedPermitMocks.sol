// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {PermitToken1271} from "./AccountMocks.sol";

/// The parts of canonical Uniswap Permit2 the typed registrations target, transcribed from
/// github.com/Uniswap/permit2 (main): `EIP712.sol` (domain without a version), `libraries/PermitHash.sol` (type
/// strings and struct hashing), `AllowanceTransfer.permit` / `_updateApproval` / `Allowance.updateAll` / `transferFrom`,
/// `SignatureTransfer.permitTransferFrom` / `_useUnorderedNonce`, and `SignatureVerification.verify` (a contract
/// owner is asked `isValidSignature(hash, signature)` with the caller's bytes, empty allowed). Etched at the canonical
/// address in tests, so the domain uses `address(this)` at call time (no immutables).
contract Permit2Mock {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    bytes32 public constant _PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 public constant _PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );
    bytes32 public constant _TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 public constant _PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 private constant _HASHED_NAME = keccak256("Permit2");
    bytes32 private constant _TYPE_HASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    error SignatureExpired(uint256 deadline);
    error InvalidNonce();
    error InvalidContractSignature();
    error InvalidSigner();
    error AllowanceExpired(uint256 deadline);
    error InsufficientAllowance(uint256 amount);
    error InvalidAmount(uint256 maxAmount);

    /// owner => token => spender
    mapping(address => mapping(address => mapping(address => PackedAllowance))) public allowance;
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(_TYPE_HASH, _HASHED_NAME, block.chainid, address(this)));
    }

    function _hashTypedData(bytes32 dataHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), dataHash));
    }

    function hashPermitSingle(PermitSingle memory p) public view returns (bytes32) {
        bytes32 permitHash = keccak256(abi.encode(_PERMIT_DETAILS_TYPEHASH, p.details));
        return _hashTypedData(keccak256(abi.encode(_PERMIT_SINGLE_TYPEHASH, permitHash, p.spender, p.sigDeadline)));
    }

    /// The digest `permitTransferFrom` checks when called by `spender`.
    function hashPermitTransferFrom(PermitTransferFrom memory p, address spender) public view returns (bytes32) {
        bytes32 tokenPermissionsHash = keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, p.permitted));
        return _hashTypedData(
            keccak256(abi.encode(_PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash, spender, p.nonce, p.deadline))
        );
    }

    function _verify(bytes calldata signature, bytes32 hash, address claimedSigner) internal view {
        if (claimedSigner.code.length == 0) {
            if (!SignatureChecker.isValidSignatureNow(claimedSigner, hash, signature)) revert InvalidSigner();
        } else {
            bytes4 magicValue = IERC1271(claimedSigner).isValidSignature(hash, signature);
            if (magicValue != IERC1271.isValidSignature.selector) revert InvalidContractSignature();
        }
    }

    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature) external {
        if (block.timestamp > permitSingle.sigDeadline) revert SignatureExpired(permitSingle.sigDeadline);
        _verify(signature, hashPermitSingle(permitSingle), owner);
        PermitDetails memory d = permitSingle.details;
        PackedAllowance storage allowed = allowance[owner][d.token][permitSingle.spender];
        if (allowed.nonce != d.nonce) revert InvalidNonce();
        unchecked {
            allowed.nonce = d.nonce + 1;
        }
        allowed.amount = d.amount;
        allowed.expiration = d.expiration == 0 ? uint48(block.timestamp) : d.expiration;
    }

    /// `AllowanceTransfer.approve`: the owner (msg.sender) sets `(amount, expiration)` directly; the nonce is kept.
    /// Zeroing is the owner's revocation path (`lockdown` is the batch form).
    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        PackedAllowance storage allowed = allowance[msg.sender][token][spender];
        allowed.amount = amount;
        allowed.expiration = expiration;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        if (block.timestamp > allowed.expiration) revert AllowanceExpired(allowed.expiration);
        uint256 maxAmount = allowed.amount;
        if (maxAmount != type(uint160).max) {
            if (amount > maxAmount) revert InsufficientAllowance(maxAmount);
            unchecked {
                allowed.amount = uint160(maxAmount) - amount;
            }
        }
        require(IERC20(token).transferFrom(from, to, amount), "transfer");
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit_,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external {
        uint256 requestedAmount = transferDetails.requestedAmount;
        if (block.timestamp > permit_.deadline) revert SignatureExpired(permit_.deadline);
        if (requestedAmount > permit_.permitted.amount) revert InvalidAmount(permit_.permitted.amount);
        uint256 wordPos = uint248(permit_.nonce >> 8);
        uint256 bit = 1 << uint8(permit_.nonce);
        uint256 flipped = nonceBitmap[owner][wordPos] ^= bit;
        if (flipped & bit == 0) revert InvalidNonce();
        _verify(signature, hashPermitTransferFrom(permit_, msg.sender), owner);
        require(IERC20(permit_.permitted.token).transferFrom(owner, transferDetails.to, requestedAmount), "transfer");
    }
}

/// USDC v2.2-style EIP-3009 token: `transferWithAuthorization` / `receiveWithAuthorization` with a `bytes signature`
/// checked by `SignatureChecker` (ERC-1271 for a contract `from`), and ERC-2612 from `PermitToken1271`.
contract Auth3009Token is PermitToken1271 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor(string memory n) PermitToken1271(n) {}

    function authDigest(
        bool receiveAuth,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes32) {
        bytes32 th = receiveAuth ? RECEIVE_WITH_AUTHORIZATION_TYPEHASH : TRANSFER_WITH_AUTHORIZATION_TYPEHASH;
        return _hashTypedDataV4(keccak256(abi.encode(th, from, to, value, validAfter, validBefore, nonce)));
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _auth(false, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        require(to == msg.sender, "caller must be the payee");
        _auth(true, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function _auth(
        bool receiveAuth,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) private {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "time");
        require(!authorizationState[from][nonce], "used");
        bytes32 d = authDigest(receiveAuth, from, to, value, validAfter, validBefore, nonce);
        require(SignatureChecker.isValidSignatureNow(from, d, signature), "bad sig");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

/// A spender that pulls through Permit2 (a router stand-in): `permit` + `transferFrom`, or `permitTransferFrom`.
contract Permit2Spender {
    function permitAndPull(
        Permit2Mock p2,
        address owner,
        Permit2Mock.PermitSingle calldata ps,
        address to,
        uint160 amount
    ) external {
        p2.permit(owner, ps, "");
        p2.transferFrom(owner, to, amount, ps.details.token);
    }

    function pullSigned(
        Permit2Mock p2,
        address owner,
        Permit2Mock.PermitTransferFrom calldata p,
        address to,
        uint256 amount
    ) external {
        p2.permitTransferFrom(p, Permit2Mock.SignatureTransferDetails(to, amount), owner, "");
    }

    function execute() external {}
}

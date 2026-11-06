// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC7739Utils} from "@openzeppelin/contracts/utils/cryptography/draft-ERC7739Utils.sol";
import {IQueueBitAccount} from "../../src/account/IQueueBitAccount.sol";
import {QueueBitAccountImpl} from "../../src/account/QueueBitAccountImpl.sol";
import {QueueBitAccountRoles} from "../../src/account/QueueBitAccountRoles.sol";
import {AccountTestBase} from "./AccountTestBase.sol";
import {Verifier1271} from "./mocks/AccountMocks.sol";

/// Scoped ERC-1271 (§10.3.2, M5): registered hashes (empty or 36-byte marker), ERC-7739 by the hot key for any app
/// domain when verified off chain, refusal for token / Permit2 callers, the 7739 sentinel, and freeze/bunker.
contract Signature1271Test is AccountTestBase {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant BAD = 0xffffffff;
    bytes32 internal constant PERSONAL_SIGN_TYPEHASH = keccak256("PersonalSign(bytes prefixed)");
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    Verifier1271 internal dapp;

    function setUp() public override {
        super.setUp();
        dapp = new Verifier1271();
    }

    function _accountDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("QueueBit"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// ERC-7739 PersonalSign envelope for `hash` (e.g. a SIWE message hash).
    function _personal(uint256 pk, bytes32 hash) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(PERSONAL_SIGN_TYPEHASH, hash));
        return _sign(pk, MessageHashUtils.toTypedDataHash(_accountDomainSeparator(), structHash));
    }

    /// ERC-7739 TypedDataSign envelope for app typed data `contents` under `appSeparator`.
    function _typed(uint256 pk, bytes32 appSeparator, bytes32 contentsHash)
        internal
        view
        returns (bytes32 hash, bytes memory sig)
    {
        string memory descr = "Login(address user,string nonce)";
        bytes memory domainBytes =
            abi.encode(keccak256("QueueBit"), keccak256("1"), block.chainid, address(account), bytes32(0));
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "TypedDataSign(Login contents,string name,string version,uint256 chainId,address verifyingContract,",
                "bytes32 salt)Login(address user,string nonce)"
            )
        );
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, contentsHash, domainBytes));
        bytes memory raw = _sign(pk, MessageHashUtils.toTypedDataHash(appSeparator, structHash));
        sig = ERC7739Utils.encodeTypedDataSig(raw, appSeparator, contentsHash, descr);
        hash = MessageHashUtils.toTypedDataHash(appSeparator, contentsHash);
    }

    /// Off-chain verification (eth_call with no `from`): the caller has no code. On-chain contract verifiers need
    /// the vault's trust (Audit.t.sol H1).
    function _check(bytes32 h, bytes memory sig) internal returns (bytes4) {
        vm.prank(address(0));
        return account.isValidSignature(h, sig);
    }

    function _register(bytes32 h) internal {
        uint48 exp = uint48(vm.getBlockTimestamp() + 1 hours);
        _hot(
            1 * USD, _one(_selfCall(abi.encodeCall(QueueBitAccountImpl.registerHash, (h, address(usdc), 1 * USD, exp))))
        );
    }

    // ------------------------------------------------------------------------------- registered hashes ------

    function test_registeredHash_emptyAndMarker() public {
        bytes32 h = keccak256("order");
        assertEq(_check(h, ""), BAD);
        _register(h);
        assertEq(_check(h, ""), MAGIC);
        assertEq(_check(h, abi.encodePacked(account.REGISTERED_MARKER(), h)), MAGIC);
        // wrong marker, marker for another hash, arbitrary bytes
        assertEq(_check(h, abi.encodePacked(bytes4(0xdeadbeef), h)), BAD);
        assertEq(_check(h, abi.encodePacked(account.REGISTERED_MARKER(), bytes32(0))), BAD);
        assertEq(_check(h, hex"01"), BAD);
        // an opaque registered hash is never honoured for a token (its debit was self-declared); `registerPermit` is
        // the way to pay for a token permit (Audit.t.sol C1)
        vm.prank(address(usdc));
        assertEq(account.isValidSignature(h, ""), BAD);
    }

    function test_registeredHash_expires() public {
        bytes32 h = keccak256("order");
        _register(h);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        assertEq(_check(h, ""), BAD);
    }

    function test_registeredHash_refusedWhileFrozenOrBunker() public {
        bytes32 h = keccak256("order");
        _register(h);
        vm.prank(guardian);
        roles.guardianFreeze();
        assertEq(_check(h, ""), BAD);
        vm.prank(vault);
        roles.vaultUnfreeze();
        assertEq(_check(h, ""), MAGIC);
        vm.prank(vault);
        roles.vaultEnableBunker();
        assertEq(_check(h, ""), BAD);
    }

    // ------------------------------------------------------------------------------------ ERC-7739 ------

    function test_personalSign_anyDomain() public {
        bytes32 h = keccak256("Sign in to example.org");
        assertEq(_check(h, _personal(hotPk, h)), MAGIC);
        assertEq(_check(h, _personal(0xBAD, h)), BAD);
        assertEq(_check(keccak256("other"), _personal(hotPk, h)), BAD);
    }

    function test_rawEcdsaOverHashIsNotAccepted() public {
        // Without the 7739 envelope a hot-key signature over `hash` is never valid (no replay across accounts).
        bytes32 h = keccak256("x");
        assertEq(_check(h, _sign(hotPk, h)), BAD);
    }

    function testFuzz_typedData_anyAppDomain(bytes32 appSeparator, bytes32 contentsHash) public {
        (bytes32 h, bytes memory sig) = _typed(hotPk, appSeparator, contentsHash);
        assertEq(_check(h, sig), MAGIC);
        (, bytes memory badSig) = _typed(0xBAD, appSeparator, contentsHash);
        assertEq(_check(h, badSig), BAD);
    }

    function test_7739_refusedForTokenCallers() public {
        bytes32 h = keccak256("permit-like");
        bytes memory sig = _personal(hotPk, h);
        vm.prank(address(usdc));
        assertEq(account.isValidSignature(h, sig), BAD, "allowlisted token asks: permit refused");
        vm.prank(address(0));
        assertEq(account.isValidSignature(h, sig), MAGIC, "eth_call with no sender is not a token");
        vm.prank(PERMIT2);
        assertEq(account.isValidSignature(h, sig), BAD, "Permit2 denied by default");
        vm.prank(vault);
        roles.vaultSetValueVerifier(address(dapp), true);
        assertEq(dapp.check(address(account), h, sig), BAD, "vault-denied verifier");
    }

    function test_7739_refusedWhileFrozenOrBunker() public {
        bytes32 h = keccak256("hi");
        bytes memory sig = _personal(hotPk, h);
        vm.prank(vault);
        roles.vaultFreeze();
        assertEq(_check(h, sig), BAD);
        vm.prank(vault);
        roles.vaultUnfreeze();
        vm.prank(vault);
        roles.vaultEnableBunker();
        assertEq(_check(h, sig), BAD);
    }

    function test_vaultMaterialNeverAccepted() public {
        // A signature by any non-hot key (e.g. a vault payer key) is not accepted on any path.
        uint256 vaultPayerPk = 0xFA017;
        bytes32 h = keccak256("vault op");
        assertEq(_check(h, _personal(vaultPayerPk, h)), BAD);
        assertEq(_check(h, _sign(vaultPayerPk, h)), BAD);
        vm.prank(vault);
        assertEq(account.isValidSignature(h, ""), BAD);
    }

    function test_supportSentinel() public {
        bytes32 s = 0x7739773977397739773977397739773977397739773977397739773977397739;
        assertEq(dapp.check(address(account), s, ""), bytes4(0x77390001));
        vm.prank(vault);
        roles.vaultFreeze();
        assertEq(dapp.check(address(account), s, ""), bytes4(0x77390001), "still detectable while frozen");
    }

    function test_eip712Domain() public view {
        (, string memory name, string memory version, uint256 chainId, address vc,,) = account.eip712Domain();
        assertEq(name, "QueueBit");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(account));
    }
}

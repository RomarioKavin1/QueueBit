// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC7739Utils} from "@openzeppelin/contracts/utils/cryptography/draft-ERC7739Utils.sol";
import {PackedUserOperation, Execution} from "../../src/modules/interfaces/IERC7579Modules.sol";
import {QueueBitPolicyHook} from "../../src/modules/QueueBitPolicyHook.sol";
import {QueueBitRoleExecutor} from "../../src/modules/QueueBitRoleExecutor.sol";
import {IERC7579AccountView, IEntryPointV08, ISafeProxyFactory} from "./hosts/HostInterfaces.sol";
import {MockToken, MockRouter} from "./mocks/ModuleMocks.sol";
import {QueueBitModulesBase} from "./QueueBitModulesBase.sol";

/// Safe7579's hook emergency exit (`Safe7579.emergencyUninstallHook`, no access control: the signature is the
/// authority, checked through the validator named in its first 20 bytes with `_msgSender()` as the 1271 sender).
struct EmergencyUninstall {
    address hook;
    uint256 hookType;
    bytes deInitData;
    uint256 nonce;
}

interface ISafe7579Emergency {
    function emergencyUninstallHook(EmergencyUninstall calldata data, bytes calldata signature) external;
}

interface ISafeDomain {
    function domainSeparator() external view returns (bytes32);
}

/// A caller with no code yet: `isValidSignature` asked from a constructor (the `extcodesize == 0` pitfall).
contract CtorProbe {
    bytes4 public immutable RESULT;

    constructor(address account, bytes32 hash, bytes memory sig) {
        RESULT = IERC1271(account).isValidSignature(hash, sig);
    }
}

/// Audit of the 4337 backend (M7): host-level 1271 consumers, hook removal, Kernel hash wrapping, install guards.
/// Numbering: A1 Safe7579 emergency hook uninstall; A2 validator without hook; A3 Kernel 1271; A4 account as a
/// 1271 sender; A5 Safe keyless owner; A6 opaque registered hashes and code-less senders.
abstract contract QueueBitModulesAuditBase is QueueBitModulesBase {
    using MessageHashUtils for bytes32;

    // keccak256("EmergencyUninstall(address hook,uint256 hookType,bytes deInitData,uint256 nonce)")
    bytes32 internal constant EMERGENCY_TYPEHASH = 0xd3ddfc12654178cc44d4a7b6b969cfdce7ffe6342326ba37825314cffa0fba9c;
    string internal constant EMERGENCY_DESCR =
        "EmergencyUninstall(address hook,uint256 hookType,bytes deInitData,uint256 nonce)";
    address internal thief = makeAddr("thief");

    function _sig1271(bytes memory sig) internal view returns (bytes memory) {
        if (_host() == Host.KERNEL) return abi.encodePacked(bytes1(0x00), sig);
        return abi.encodePacked(address(validator), sig);
    }

    function _isValid(address asker, bytes32 h, bytes memory sig) internal returns (bool) {
        vm.prank(asker);
        try IERC7579AccountView(account).isValidSignature(h, _sig1271(sig)) returns (bytes4 r) {
            return r == 0x1626ba7e;
        } catch {
            return false;
        }
    }

    function _register(bytes32 h) internal {
        _submitOk(
            _op(
                _single(
                    address(hook),
                    0,
                    abi.encodeCall(
                        QueueBitPolicyHook.registerHash, (h, address(usdc), 1, uint48(block.timestamp + 30 days))
                    )
                )
            )
        );
    }

    /// ERC-7739 TypedDataSign by the hot key over `contentsHash` in the app domain `appSep`.
    function _sign7739(bytes32 appSep, bytes32 contentsHash, string memory descr, string memory name)
        internal
        view
        returns (bytes memory)
    {
        bytes memory domainBytes =
            abi.encode(keccak256("QueueBitHotValidator"), keccak256("1"), block.chainid, account, bytes32(0));
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "TypedDataSign(",
                name,
                " contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)",
                descr
            )
        );
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, contentsHash, domainBytes));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotPk, appSep.toTypedDataHash(structHash));
        return ERC7739Utils.encodeTypedDataSig(abi.encodePacked(r, s, v), appSep, contentsHash, descr);
    }

    function _openSessions() internal {
        Call[] memory c = new Call[](2);
        uint48 exp = uint48(block.timestamp + 30 days);
        c[0] = Call(
            address(hook),
            0,
            abi.encodeCall(QueueBitPolicyHook.setSession, (account, address(usdc), IERC20.approve.selector, 400e6, exp))
        );
        c[1] = Call(
            address(hook),
            0,
            abi.encodeCall(QueueBitPolicyHook.setSession, (account, address(router), router.pull.selector, 400e6, exp))
        );
        _queueAndRun(c, 1);
    }

    function _approvePull(uint256 amt, address to) internal view returns (bytes memory) {
        Execution[] memory e = new Execution[](2);
        e[0] = Execution(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(router), amt)));
        e[1] = Execution(address(router), 0, abi.encodeCall(router.pull, (IERC20(address(usdc)), amt, to)));
        return _batch(e);
    }

    // ------------------------------------------------------------------- A4: the account is never a hot verifier

    /// Kernel's enable mode (`_verifyEnableSig`) asks the root validator with `sender = address(this)`: a leaked hot
    /// key must not be able to answer for the account itself, registered hash or not.
    function test_A4_accountIsNeverAHotVerifier() public {
        bytes32 h = keccak256("enable");
        _register(h);
        assertFalse(hook.hotVerifierAllowed(account, account));
        vm.prank(account);
        assertEq(validator.isValidSignatureWithSender(account, h, ""), bytes4(0xffffffff));
        vm.prank(account);
        assertEq(
            validator.isValidSignatureWithSender(account, h, abi.encodePacked(bytes4(0x427a9529), h)),
            bytes4(0xffffffff)
        );
    }
}

contract QueueBitModulesAuditSafe7579Test is QueueBitModulesAuditBase {
    using MessageHashUtils for bytes32;

    function _host() internal pure override returns (Host) {
        return Host.SAFE7579;
    }

    function _emergencyHash(uint256 nonce) internal view returns (bytes32 structHash, bytes32 digest) {
        structHash = keccak256(abi.encode(EMERGENCY_TYPEHASH, address(hook), uint256(4), keccak256(""), nonce));
        digest =
            keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), ISafeDomain(account).domainSeparator(), structHash));
    }

    /// `emergencyUninstallHook` from an EOA transaction, expecting Safe7579's `EmergencyUninstallSigError`.
    function _emergencyRefused(uint256 nonce, bytes memory sig) internal {
        EmergencyUninstall memory d = EmergencyUninstall(address(hook), 4, "", nonce);
        vm.prank(thief, thief);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("EmergencyUninstallSigError()"))));
        ISafe7579Emergency(account).emergencyUninstallHook(d, abi.encodePacked(address(validator), sig));
    }

    /// PoC (A1, critical before the fix): the hot key registers Safe7579's `EmergencyUninstall` digest as an opaque
    /// hash (1 wei of declared value); any EOA then requests and, a day later, completes the hook uninstall (the
    /// hook's `onUninstall` reverts, Safe7579 wraps it in a try). Without the hook nothing debits the bucket,
    /// measures deltas or enforces I-6: a session batch swept the whole USDC balance to the thief ($5000 against a
    /// $1000/day cap). Fixed: an opaque registered hash is never honoured for a non-zero code-less sender.
    function test_A1_emergencyUninstallHook_registeredHash_refused() public {
        _openSessions();
        (, bytes32 d1) = _emergencyHash(1);
        _register(d1);
        assertTrue(_isValid(address(0), d1, ""), "the registration itself works for eth_call");
        _emergencyRefused(1, "");
        _emergencyRefused(1, abi.encodePacked(bytes4(0x427a9529), d1));
        assertTrue(IERC7579AccountView(account).isModuleInstalled(4, address(hook), ""), "hook stays");
        // The hook still bounds the hot tier: the sweep is refused (session allowance) and nothing moves.
        _expectExecFail(_op(_approvePull(5000e6, thief)), "");
        assertEq(usdc.balanceOf(thief), 0);
    }

    /// PoC (A1b): the same through ERC-7739 nested typed data in the Safe's own domain (the hot key may sign for
    /// "any app domain"), asked from an EOA transaction and from a contract under construction (both code-less).
    /// Fixed: the account's own domain (Safe `domainSeparator()`) is never a hot-key app domain.
    function test_A1b_emergencyUninstallHook_7739_refused() public {
        (bytes32 s1, bytes32 d1) = _emergencyHash(1);
        bytes32 safeSep = ISafeDomain(account).domainSeparator();
        assertEq(validator.hostDomainSeparator(account, hook.hostOf(account)), safeSep, "Safe domain detected");
        bytes memory sig = _sign7739(safeSep, s1, EMERGENCY_DESCR, "EmergencyUninstall");
        assertEq(new CtorProbe(account, d1, _sig1271(sig)).RESULT(), bytes4(0xffffffff), "constructor caller");
        assertFalse(_isValid(stranger, d1, sig), "EOA");
        assertFalse(_isValid(address(0), d1, sig), "eth_call");
        _emergencyRefused(1, sig);
        // The same envelope in a real app domain still works for eth_call verification (the rule is domain-scoped).
        bytes32 appSep = keccak256(abi.encode(keccak256("EIP712Domain(string name)"), keccak256("App")));
        bytes32 c = keccak256(abi.encode(keccak256("Login(uint256 nonce)"), uint256(7)));
        assertTrue(_isValid(stranger, appSep.toTypedDataHash(c), _sign7739(appSep, c, "Login(uint256 nonce)", "Login")));
    }

    /// A2 (Safe7579): with the hook unbound (here by storage, standing in for any host path), hot ops fail closed.
    function test_A2_validatorFailsClosedWithoutHook() public {
        assertTrue(validator.hookBound(account));
        // Safe7579 `$globalHook[safe]`: find the slot by replaying the install write.
        vm.record();
        IERC7579AccountView(account).isModuleInstalled(4, address(hook), "");
        address adapter = _safe7579();
        (bytes32[] memory reads,) = vm.accesses(adapter);
        assertEq(reads.length, 1, "one slot: $globalHook[safe]");
        vm.store(adapter, reads[0], bytes32(0));
        assertFalse(validator.hookBound(account));
        _expectValidationRevert(
            _op(_single(recipient, 0.01 ether, "")), abi.encodeWithSelector(HookNotInstalled.selector)
        );
    }

    function _safe7579() internal view returns (address) {
        // The Safe's fallback handler slot (keccak256("fallback_manager.handler.address")).
        return address(
            uint160(uint256(vm.load(account, 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5)))
        );
    }
}

/// A5: a Safe with an owner somebody holds a key for cannot install the hook (the owner path bypasses it).
contract QueueBitModulesAuditSafeOwnerTest is QueueBitModulesBase {
    address internal keyedOwner = makeAddr("keyed-owner");

    function _host() internal pure override returns (Host) {
        return Host.SAFE7579;
    }

    function _safeOwner() internal view override returns (address) {
        return keyedOwner;
    }

    function setUp() public override {
        vm.warp(1_800_000_000);
        ep = IEntryPointV08(deployEntryPointV08());
        (hotKey, hotPk) = makeAddrAndKey("hot");
        _deployModules();
        usdc = new MockToken("USDC", 6);
        router = new MockRouter();
    }

    function test_A5_safeKeyedOwnerRefused() public {
        (address factory, address singleton, bytes memory setup) =
            _safeSetup(abi.encode(_hookInit()), abi.encode(_executorInit()));
        // The Safe setup (launchpad -> Safe7579 -> hook.onInstall: HostOwnerNotKeyless) reverts; nothing is created.
        vm.expectRevert();
        ISafeProxyFactory(factory).createProxyWithNonce(singleton, setup, 7579);
        // Directly: the hook names the owner.
        SafeOwnersStub stub = new SafeOwnersStub(keyedOwner);
        vm.prank(address(stub));
        vm.expectRevert(abi.encodeWithSelector(HostOwnerNotKeyless.selector, keyedOwner));
        hook.onInstall(abi.encode(_hookInit()));
    }
}

contract SafeOwnersStub {
    address[] internal owners;

    constructor(address owner) {
        owners.push(owner);
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }
}

contract QueueBitModulesAuditMSATest is QueueBitModulesAuditBase {
    function _host() internal pure override returns (Host) {
        return Host.MSA;
    }

    bytes32 internal constant MSA_HOOK_SLOT = 0xcd97a6611018468306afd07ac8b14141bc76df8b844b3bcba1768d81e4598200;

    /// A2: with the hook gone from the host (whatever removed it), the validator must fail closed. Before the fix the
    /// op went through and nothing debited the bucket.
    function test_A2_validatorFailsClosedWithoutHook() public {
        assertTrue(validator.hookBound(account));
        vm.store(account, MSA_HOOK_SLOT, bytes32(0));
        assertFalse(IERC7579AccountView(account).isModuleInstalled(4, address(hook), ""));
        assertFalse(validator.hookBound(account));
        _expectValidationRevert(
            _op(_single(recipient, 0.1 ether, "")), abi.encodeWithSelector(HookNotInstalled.selector)
        );
        assertEq(recipient.balance, 0);
    }

    /// A7: a vault signature is bound to the chain and to this executor (EIP-712 domain), to the account and to
    /// the lane nonce: the same digest on another chain, or against a second executor deployment, is a different
    /// digest; the same `calls` under another account need their own signature.
    function test_A7_vaultDigestBoundToChainExecutorAccount() public {
        Call[] memory c = _calls1(stranger, 0.1 ether, "");
        uint256 n = _vaultNonce();
        bytes32 d = executor.hashVaultExec(account, n, c, 0);
        bytes memory sig = _pqSign(vaultPk, d);
        assertTrue(d != executor.hashVaultExec(stranger, n, c, 0), "account");
        assertTrue(d != executor.hashVaultExec(account, n + 1, c, 0), "nonce");
        QueueBitRoleExecutor other = new QueueBitRoleExecutor();
        assertTrue(d != other.hashVaultExec(account, n, c, 0), "executor address");
        // Literals: solc treats CHAINID as invariant and would re-read it after the cheatcode.
        assertEq(block.chainid, 31337);
        vm.chainId(31338);
        assertTrue(d != executor.hashVaultExec(account, n, c, 0), "chain id");
        vm.expectRevert(BadSignature.selector);
        executor.vaultExec(account, c, 0, n, sig);
        vm.chainId(31337);
        assertEq(d, executor.hashVaultExec(account, n, c, 0), "digest restored");
        assertEq(n, _vaultNonce(), "nonce untouched by the reverted call");
        executor.vaultExec(account, c, 0, n, sig);
        assertEq(stranger.balance, 0.1 ether);
    }

    /// The generic host (MSA) has no EIP-712 domain: no app domain is excluded, 7739 works as before.
    function test_hostDomain_noneOnMSA() public view {
        assertEq(validator.hostDomainSeparator(account, hook.hostOf(account)), bytes32(0));
        assertEq(hook.hostOf(account), 0);
    }

    /// A6: an opaque registered hash is honoured for a plain eth_call (sender 0) but not for an arbitrary code-less
    /// sender: an EOA sending a transaction, or a contract under construction, are both "code-less".
    function test_A6_opaqueHash_codelessSenders() public {
        bytes32 h = keccak256("order");
        _register(h);
        assertTrue(_isValid(address(0), h, ""), "eth_call");
        assertFalse(_isValid(stranger, h, ""), "EOA sender");
        assertEq(new CtorProbe(account, h, _sig1271("")).RESULT(), bytes4(0xffffffff), "constructor caller");
    }
}

contract QueueBitModulesAuditKernelTest is QueueBitModulesAuditBase {
    using MessageHashUtils for bytes32;

    function _host() internal pure override returns (Host) {
        return Host.KERNEL;
    }

    function _kernelSep() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Kernel"),
                keccak256("0.3.3"),
                block.chainid,
                account
            )
        );
    }

    /// A3: Kernel passes the validator `hashTypedData(Kernel(bytes32 hash))`; "unsupported" for apps, but a hot key
    /// that registers (or 7739-signs) the wrapped hash makes Kernel's 1271 answer MAGIC. On Kernel, hot 1271 is off.
    function test_A3_kernel1271_wrappedHash() public {
        assertEq(hook.hostOf(account), 1, "Kernel detected");
        assertEq(validator.hostDomainSeparator(account, 1), _kernelSep(), "EIP-5267 domain");
        bytes32 h = keccak256("order");
        bytes32 inner = keccak256(abi.encode(keccak256("Kernel(bytes32 hash)"), h));
        bytes32 wrapped = _kernelSep().toTypedDataHash(inner);
        _register(wrapped);
        assertFalse(_isValid(address(0), h, ""), "registered wrapped hash");
        bytes memory sig = _sign7739(_kernelSep(), inner, "Kernel(bytes32 hash)", "Kernel");
        assertFalse(_isValid(stranger, h, sig), "7739 over the wrapped hash");
    }

    /// A2 (Kernel): `uninstallModule(4, hook)` unbinds the root validator's hook (`onUninstall` revert swallowed).
    function test_A2_validatorFailsClosedWithoutHook() public {
        assertTrue(validator.hookBound(account));
        vm.prank(EP_ADDR);
        IERC7579AccountView(account).uninstallModule(4, address(hook), "");
        assertFalse(validator.hookBound(account));
        _expectValidationRevert(
            _opRaw(_single(recipient, 0.01 ether, "")), abi.encodeWithSelector(HookNotInstalled.selector)
        );
        _expectValidationRevert(
            _op(_single(recipient, 0.01 ether, "")), abi.encodeWithSelector(HookNotInstalled.selector)
        );
    }
}

/// A1-A7 again with the account installed in Strict (the suites above run in Open, the install default).
contract QueueBitModulesAuditSafe7579StrictTest is QueueBitModulesAuditSafe7579Test {
    function _recipientMode() internal pure override returns (RecipientMode) {
        return RecipientMode.Strict;
    }
}

contract QueueBitModulesAuditSafeOwnerStrictTest is QueueBitModulesAuditSafeOwnerTest {
    function _recipientMode() internal pure override returns (RecipientMode) {
        return RecipientMode.Strict;
    }
}

contract QueueBitModulesAuditMSAStrictTest is QueueBitModulesAuditMSATest {
    function _recipientMode() internal pure override returns (RecipientMode) {
        return RecipientMode.Strict;
    }
}

contract QueueBitModulesAuditKernelStrictTest is QueueBitModulesAuditKernelTest {
    function _recipientMode() internal pure override returns (RecipientMode) {
        return RecipientMode.Strict;
    }
}

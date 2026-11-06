// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DepsRegistry} from "../../src/leanpool/DepsRegistry.sol";
import {FrameHelperHub} from "../../src/account/FrameOps.sol";
import {KeystoreValidator, IRingRegistry} from "../../src/account/KeystoreValidator.sol";
import {LeanAccount} from "../../src/account/LeanAccount.sol";
import {LeanAccountFactory} from "../../src/account/LeanAccountFactory.sol";
import {SpendingLimitHook, ISessionContext} from "../../src/account/SpendingLimitHook.sol";
import {TestToken} from "./fixtures/LegacyAccount.sol";

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
}

/// The TS SDK (packages/account) against the contracts it targets: the same inputs as packages/account/test/fixture.ts
/// give the same counterfactual address, MultiSend bytes and Safe transaction hash (constants pinned on both sides),
/// and a Safe really moves into a LeanAccount with the migration the SDK builds.
contract SdkParityTest is Test {
    // packages/account/test/fixture.ts
    address constant KEYSTORE = address(0xa2);
    address constant IMPL = address(0xa3);
    address constant FACTORY = address(0xa4);
    address constant HOOK = address(0xa5);
    address constant AGG = address(0xab);
    address constant SAFE = address(0x5af);
    address constant MULTISEND = address(0x115e);
    address constant TOKEN = address(0x70c1);
    bytes32 constant VK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 constant SALT = bytes32(uint256(0x77));

    // packages/account/test/parity.test.ts pins the same values.
    address constant TARGET = 0x7FFCFa3A2Cb400AA5F8201a9f687800723E4885f;
    bytes32 constant MULTISEND_HASH = 0x357ef6153c692f2e109e91744ff69339c971ba4dbee47a0b35fb203c3ab2047f;
    bytes32 constant SAFE_TX_HASH = 0xa2d91144baabe69130353cefffb84e23fc076ed68130d5af9883452314291ef5;

    function _init(address keystore, address hook, bytes32 vk) internal pure returns (LeanAccountFactory.Init memory) {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](1);
        keys[0] = KeystoreValidator.KeyInit(1, 1, 3, 0, 0, vk, bytes32(0), new address[](0));
        KeystoreValidator.Policy memory p = KeystoreValidator.Policy(1, 1, true, AGG);
        return LeanAccountFactory.Init(keystore, abi.encode(p, keys), hook, "", new address[](0), new bytes[](0));
    }

    /// The migration calls the SDK builds (moveCalls): the token to the target, then createAccount{value: all ETH}.
    function _multiSend(
        address factory,
        LeanAccountFactory.Init memory init,
        address token,
        address target,
        uint256 tokens,
        uint256 eth
    ) internal pure returns (bytes memory) {
        bytes memory t = abi.encodeCall(TestToken.transfer, (target, tokens));
        bytes memory c = abi.encodeCall(LeanAccountFactory.createAccount, (SALT, init));
        return abi.encodePacked(
            uint8(0), token, uint256(0), uint256(t.length), t, uint8(0), factory, eth, uint256(c.length), c
        );
    }

    function _safeExecData(bytes memory packed) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("multiSend(bytes)", packed);
    }

    function test_predictMatchesTheSdk() public {
        deployCodeTo("LeanAccountFactory.sol:LeanAccountFactory", abi.encode(IMPL), FACTORY);
        assertEq(LeanAccountFactory(FACTORY).predict(SALT, _init(KEYSTORE, HOOK, VK)), TARGET);
    }

    function test_multiSendAndSafeTxHashMatchTheSdk() public {
        bytes memory packed = _multiSend(FACTORY, _init(KEYSTORE, HOOK, VK), TOKEN, TARGET, 5e18, 1e18);
        assertEq(keccak256(packed), MULTISEND_HASH);

        vm.chainId(1337);
        address singleton = deployCode("Safe.sol:Safe");
        deployCodeTo("SafeProxy.sol:SafeProxy", abi.encode(singleton), SAFE);
        address[] memory owners = new address[](1);
        owners[0] = address(0xbeef);
        ISafe(SAFE).setup(owners, 1, address(0), "", address(0), address(0), 0, address(0));
        bytes32 h =
            ISafe(SAFE).getTransactionHash(MULTISEND, 0, _safeExecData(packed), 1, 0, 0, 0, address(0), address(0), 0);
        assertEq(h, SAFE_TX_HASH);
    }

    /// A 2-of-2 Safe holding ETH and a token moves everything into a new PQ LeanAccount in one Safe transaction.
    function test_aSafeMovesIntoALeanAccount() public {
        DepsRegistry registry = new DepsRegistry(0.01 ether);
        FrameHelperHub hub = new FrameHelperHub();
        KeystoreValidator ks = new KeystoreValidator(IRingRegistry(address(registry)), hub);
        LeanAccount impl = new LeanAccount(hub);
        LeanAccountFactory factory = new LeanAccountFactory(address(impl));
        SpendingLimitHook hook = new SpendingLimitHook(ISessionContext(address(ks)));
        TestToken token = new TestToken("USDC", 6);
        address multiSend = deployCode("MultiSendCallOnly.sol:MultiSendCallOnly");

        (address o1, uint256 k1) = makeAddrAndKey("owner 1");
        (address o2, uint256 k2) = makeAddrAndKey("owner 2");
        address safe = deployCode("SafeProxy.sol:SafeProxy", abi.encode(deployCode("Safe.sol:Safe")));
        address[] memory owners = new address[](2);
        (owners[0], owners[1]) = (o1, o2);
        ISafe(safe).setup(owners, 2, address(0), "", address(0), address(0), 0, address(0));
        vm.deal(safe, 1 ether);
        token.mint(safe, 5e6);

        LeanAccountFactory.Init memory init = _init(address(ks), address(hook), VK);
        address target = factory.predict(SALT, init);
        bytes memory data = _safeExecData(_multiSend(address(factory), init, address(token), target, 5e6, 1 ether));
        bytes32 h = ISafe(safe).getTransactionHash(multiSend, 0, data, 1, 0, 0, 0, address(0), address(0), 0);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(k1, h);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(k2, h);
        bytes memory sigs =
            o1 < o2 ? abi.encodePacked(r1, s1, v1, r2, s2, v2) : abi.encodePacked(r2, s2, v2, r1, s1, v1);

        vm.prank(makeAddr("anyone")); // execution is permissionless: the owners' signatures authorize it
        assertTrue(ISafe(safe).execTransaction(multiSend, 0, data, 1, 0, 0, 0, address(0), address(0), sigs));

        assertGt(target.code.length, 0, "the LeanAccount exists");
        assertEq(target.balance, 1 ether);
        assertEq(token.balanceOf(target), 5e6);
        assertEq(safe.balance, 0);
        assertEq(token.balanceOf(safe), 0);
        assertEq(ks.getKey(target, ks.keyIdOf(1, VK, 0)).kind, 1, "the PQ owner key is installed");
    }
}

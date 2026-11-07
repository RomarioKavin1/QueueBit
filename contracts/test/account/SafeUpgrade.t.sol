// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DepsRegistry} from "../../src/leanpool/DepsRegistry.sol";
import {FrameHelperHub} from "../../src/account/FrameOps.sol";
import {KeystoreValidator, IRingRegistry} from "../../src/account/KeystoreValidator.sol";
import {LeanAccount} from "../../src/account/LeanAccount.sol";
import {SafeToLeanAccount} from "../../src/account/SafeToLeanAccount.sol";
import {SpendingLimitHook, ISessionContext} from "../../src/account/SpendingLimitHook.sol";
import {TestToken} from "./fixtures/LegacyAccount.sol";

interface ISafeLike {
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
    function getOwners() external view returns (address[] memory);
}

/// A Safe v1.4.1 becomes a LeanAccount at the same address, in one Safe transaction its owners sign: a DELEGATECALL
/// into SafeToLeanAccount points the proxy at LeanAccount and initializes it with the PQ owner key.
/// Safe v1.4.1 is built by the legacy-pipeline profile, so it is deployed from its artifact path: with two compiler
/// profiles, forge 1.3.5's name lookup ("Safe.sol:Safe") finds no artifact.
contract SafeUpgradeTest is Test {
    bytes32 constant VK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address constant AGG = address(0xab);

    KeystoreValidator ks;
    LeanAccount impl;
    SpendingLimitHook hook;
    SafeToLeanAccount helper;
    TestToken token;
    address safe;
    uint256 k1;
    uint256 k2;
    address o1;
    address o2;

    function setUp() public {
        DepsRegistry registry = new DepsRegistry(0.01 ether);
        FrameHelperHub hub = new FrameHelperHub();
        ks = new KeystoreValidator(IRingRegistry(address(registry)), hub);
        impl = new LeanAccount(hub);
        hook = new SpendingLimitHook(ISessionContext(address(ks)));
        helper = new SafeToLeanAccount();
        token = new TestToken("USDC", 6);
        (o1, k1) = makeAddrAndKey("owner 1");
        (o2, k2) = makeAddrAndKey("owner 2");
        safe = deployCode("out/SafeProxy.sol/SafeProxy.json", abi.encode(deployCode("out/Safe.sol/Safe.json")));
        address[] memory owners = new address[](2);
        (owners[0], owners[1]) = (o1, o2);
        ISafeLike(safe).setup(owners, 2, address(0), "", address(0), address(0), 0, address(0));
        vm.deal(safe, 1 ether);
        token.mint(safe, 5e6);
    }

    function _initData() internal view returns (bytes memory) {
        KeystoreValidator.KeyInit[] memory keys = new KeystoreValidator.KeyInit[](1);
        keys[0] = KeystoreValidator.KeyInit(1, 1, 3, 0, 0, VK, bytes32(0), new address[](0));
        KeystoreValidator.Policy memory p = KeystoreValidator.Policy(1, 1, true, AGG);
        return abi.encodeCall(
            LeanAccount.initialize,
            (address(ks), abi.encode(p, keys), address(hook), "", new address[](0), new bytes[](0))
        );
    }

    function _sigs(bytes memory data) internal view returns (bytes memory) {
        bytes32 h = ISafeLike(safe).getTransactionHash(address(helper), 0, data, 1, 0, 0, 0, address(0), address(0), 0);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(k1, h);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(k2, h);
        return o1 < o2 ? abi.encodePacked(r1, s1, v1, r2, s2, v2) : abi.encodePacked(r2, s2, v2, r1, s1, v1);
    }

    function _exec(bytes memory data, bytes memory sigs) internal returns (bool) {
        vm.prank(makeAddr("anyone"));
        return ISafeLike(safe).execTransaction(address(helper), 0, data, 1, 0, 0, 0, address(0), address(0), sigs);
    }

    function test_aSafeUpgradesInPlace() public {
        bytes memory data = abi.encodeCall(SafeToLeanAccount.migrate, (address(impl), _initData()));
        assertTrue(_exec(data, _sigs(data)));

        // Same address, same money, now a LeanAccount owned by the PQ key.
        assertEq(address(uint160(uint256(vm.load(safe, 0)))), address(impl), "the proxy forwards to LeanAccount");
        assertEq(safe.balance, 1 ether);
        assertEq(token.balanceOf(safe), 5e6);
        assertEq(ks.getKey(safe, ks.keyIdOf(1, VK, 0)).kind, 1, "the PQ owner key is installed");
        assertTrue(LeanAccount(payable(safe)).isModuleInstalled(11, address(ks), ""), "keystore installed");

        // The Safe's code is gone: its owners can't run it any more.
        vm.expectRevert();
        ISafeLike(safe).getOwners();
        // It still takes ETH.
        (bool ok,) = safe.call{value: 1}("");
        assertTrue(ok);
    }

    function test_refusesACallThatIsNotADelegatecall() public {
        vm.expectRevert(SafeToLeanAccount.OnlyDelegateCall.selector);
        helper.migrate(address(impl), _initData());
    }

    function test_refusesATargetThatIsNotAContract() public {
        bytes memory data = abi.encodeCall(SafeToLeanAccount.migrate, (address(0xdead), _initData()));
        bytes memory sigs = _sigs(data);
        vm.expectRevert(bytes("GS013")); // the whole Safe transaction reverts: nothing changes
        _exec(data, sigs);
        assertEq(ISafeLike(safe).getOwners().length, 2);
    }
}

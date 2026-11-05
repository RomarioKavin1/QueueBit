// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PackedUserOperation, Execution} from "../../src/modules/interfaces/IERC7579Modules.sol";
import {ILeakedModules} from "../../src/modules/interfaces/ILeakedModules.sol";
import {LeakedPolicyHook} from "../../src/modules/LeakedPolicyHook.sol";
import {LeakedHotValidator} from "../../src/modules/LeakedHotValidator.sol";
import {LeakedRoleExecutor} from "../../src/modules/LeakedRoleExecutor.sol";
import {IPQVerifier} from "../../src/interfaces/IPQVerifier.sol";
import {MockPQVerifier, MockToken, MockRouter} from "./mocks/ModuleMocks.sol";
import {
    IEntryPointV08,
    IMSABootstrap,
    IMSAFactory,
    MSABootstrapConfig,
    ISafeSetup,
    ISafeProxyFactory,
    ISafe7579Launchpad,
    Safe7579ModuleInit,
    IKernelFactory,
    IKernelInit,
    ISimpleAccount
} from "./hosts/HostInterfaces.sol";

/// ModuleKit-style harness: one `AccountInstance`-like account per host (reference MSA, Safe7579, Kernel v3.3) with
/// the three LEAKED modules installed, driven through a real EntryPoint v0.8.0 at its canonical address with
/// `handleOps`. (ModuleKit itself is not used: it is unmaintained since 2026-09 (modulekit commit 2210e2b, README), pulls
/// its dependencies through npm and is AGPL/GPL; this harness reimplements the parts we need, see
/// IMPLEMENTATION-NOTES.md.)
abstract contract LeakedModulesBase is Test, ILeakedModules {
    enum Host {
        MSA,
        SAFE7579,
        KERNEL
    }

    /// EntryPoint v0.8: CREATE2 via 0x4e59b448… with salt 0x0a59dbff…5e35e9 (verified 2026-11-06 against the
    /// mainnet deploy tx 0xae4eafd1… and `cast code` on mainnet and Sepolia; see IMPLEMENTATION-NOTES.md).
    address internal constant EP_ADDR = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    address internal constant CREATE2_DEPLOYER_ADDR = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant EP_SALT = 0x0a59dbff790c23c976a548690c27297883cc66b4c67024f9117b0238995e35e9;
    bytes internal constant ARACHNID_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f;

    uint256 internal constant CAP = 1000e6; // $1000 / day
    uint256 internal constant PER_TX = 500e6;
    uint256 internal constant MAX_FEE_WEI = 0.05 ether;
    uint256 internal constant MAX_PRIO = 10 gwei;
    uint256 internal constant ETH_USD = 3000e6;
    uint256 internal constant VAULT_THRESHOLD = 5000e6;

    IEntryPointV08 internal ep;
    LeakedRoleExecutor internal executor;
    LeakedPolicyHook internal hook;
    LeakedHotValidator internal validator;
    IPQVerifier internal pq;
    MockToken internal usdc;
    MockRouter internal router;

    address internal account;
    uint256 internal hotPk;
    address internal hotKey;
    bytes32 internal vaultPk = keccak256("vault-pk");
    bytes32 internal recoveryPk = keccak256("recovery-pk");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");
    address internal guardian = makeAddr("guardian");
    address payable internal bundler = payable(makeAddr("bundler"));

    function _host() internal pure virtual returns (Host);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        ep = IEntryPointV08(deployEntryPointV08());
        (hotKey, hotPk) = makeAddrAndKey("hot");
        _deployModules();
        usdc = new MockToken("USDC", 6);
        router = new MockRouter();
        account = _createAccount(_host(), _hookInit(), _executorInit());
        vm.deal(account, 10 ether);
        usdc.mint(account, 10_000e6);
    }

    /// Deploys EntryPoint v0.8.0 exactly as on mainnet: the initcode of `deployments/ethereum/EntryPoint.json`
    /// (identical to the input of mainnet tx 0xae4eafd1…) through the deterministic deployer with the release salt.
    function deployEntryPointV08() internal returns (address) {
        if (EP_ADDR.code.length != 0) return EP_ADDR;
        if (CREATE2_DEPLOYER_ADDR.code.length == 0) vm.etch(CREATE2_DEPLOYER_ADDR, ARACHNID_RUNTIME);
        bytes memory initCode =
            vm.parseJsonBytes(vm.readFile("lib/account-abstraction/deployments/ethereum/EntryPoint.json"), ".bytecode");
        (bool ok,) = CREATE2_DEPLOYER_ADDR.call(abi.encodePacked(EP_SALT, initCode));
        require(ok && EP_ADDR.code.length != 0, "EntryPoint v0.8 not at its canonical address");
        return EP_ADDR;
    }

    function _deployModules() internal virtual {
        executor = new LeakedRoleExecutor();
        hook = new LeakedPolicyHook(address(executor));
        validator = new LeakedHotValidator(hook);
        pq = new MockPQVerifier();
    }

    function _hookInit() internal view virtual returns (HookInit memory c) {
        c.hotKey = hotKey;
        c.capUsdPerDay = CAP;
        c.perTxMaxUsd = PER_TX;
        c.maxFeeWei = MAX_FEE_WEI;
        c.maxPriorityFeePerGas = MAX_PRIO;
        c.ethUsdPrice = ETH_USD;
        c.tokens = new TokenInit[](1);
        c.tokens[0] = TokenInit(address(usdc), 6, 1e6);
        c.targets = new address[](1);
        c.targets[0] = recipient;
    }

    function _executorInit() internal view virtual returns (ExecutorInit memory c) {
        c.hook = address(hook);
        c.verifier = address(pq);
        c.vaultPk = vaultPk;
        c.recoveryPk = recoveryPk;
        c.timelockDelay = 48 hours;
        c.timelockThresholdUsd = VAULT_THRESHOLD;
        c.guardians = new address[](1);
        c.guardians[0] = guardian;
    }

    // ------------------------------------------------------------------------------------------ hosts ------

    function _createAccount(Host h, HookInit memory hi, ExecutorInit memory xi) internal returns (address) {
        bytes memory hookData = abi.encode(hi);
        bytes memory execData = abi.encode(xi);
        if (h == Host.MSA) return _createMSA(hookData, execData);
        if (h == Host.SAFE7579) return _createSafe(hookData, execData);
        return _createKernel(hookData, execData);
    }

    function _createMSA(bytes memory hookData, bytes memory execData) internal returns (address) {
        address impl = deployCode("out/HostArtifacts.sol/MSAAdvancedEP.json", abi.encode(EP_ADDR));
        address factory = deployCode("out/MSAFactory.sol/MSAFactory.json", abi.encode(impl));
        address bootstrap = deployCode("out/Bootstrap.sol/Bootstrap.json");
        MSABootstrapConfig[] memory vals = new MSABootstrapConfig[](1);
        vals[0] = MSABootstrapConfig(address(validator), "");
        MSABootstrapConfig[] memory execs = new MSABootstrapConfig[](1);
        execs[0] = MSABootstrapConfig(address(executor), execData);
        MSABootstrapConfig[] memory fbs = new MSABootstrapConfig[](0);
        bytes memory initCode = abi.encode(
            bootstrap,
            abi.encodeCall(IMSABootstrap.initMSA, (vals, execs, MSABootstrapConfig(address(hook), hookData), fbs))
        );
        return IMSAFactory(factory).createAccount(keccak256("leaked-msa"), initCode);
    }

    function _createSafe(bytes memory hookData, bytes memory execData) internal returns (address) {
        (address proxyFactory, address singleton, bytes memory setup) = _safeSetup(hookData, execData);
        return ISafeProxyFactory(proxyFactory).createProxyWithNonce(singleton, setup, 7579);
    }

    /// Deploys the Safe stack and builds the `setup` call that installs the three modules through the launchpad.
    function _safeSetup(bytes memory hookData, bytes memory execData)
        internal
        returns (address proxyFactory, address singleton, bytes memory setup)
    {
        singleton = deployCode("out/Safe.sol/Safe.json");
        proxyFactory = deployCode("out/SafeProxyFactory.sol/SafeProxyFactory.json");
        address safe7579 = deployCode("out/HostArtifacts.sol/Safe7579EP08.json");
        address launchpad =
            deployCode("out/Safe7579Launchpad.sol/Safe7579Launchpad.json", abi.encode(EP_ADDR, address(0)));
        Safe7579ModuleInit[] memory mods = new Safe7579ModuleInit[](3);
        mods[0] = Safe7579ModuleInit(address(validator), "", 1);
        mods[1] = Safe7579ModuleInit(address(executor), execData, 2);
        mods[2] = Safe7579ModuleInit(address(hook), hookData, 4);
        // The Safe's own owner path must be unusable: one owner nobody holds a key for (see IMPLEMENTATION-NOTES);
        // the hook refuses any other owner at install (`KEYLESS_OWNER`, audit A5).
        address[] memory owners = new address[](1);
        owners[0] = _safeOwner();
        setup = abi.encodeCall(
            ISafeSetup.setup,
            (
                owners,
                1,
                launchpad,
                abi.encodeCall(ISafe7579Launchpad.addSafe7579, (safe7579, mods, new address[](0), 0)),
                address(0),
                address(0),
                0,
                payable(address(0))
            )
        );
    }

    function _safeOwner() internal view virtual returns (address) {
        return 0x000000000000000000000000000000000000dEaD;
    }

    function _createKernel(bytes memory hookData, bytes memory execData) internal returns (address) {
        address impl = deployCode("out/Kernel.sol/Kernel.json", abi.encode(EP_ADDR));
        address factory = deployCode("out/KernelFactory.sol/KernelFactory.json", abi.encode(impl));
        bytes21 rootVid = bytes21(abi.encodePacked(bytes1(0x01), address(validator)));
        bytes[] memory cfg = new bytes[](1);
        // Executor with this hook bound (Kernel binds hooks per validator/executor; plan R-6).
        cfg[0] = abi.encodeCall(
            IKernelInit.installModule,
            (2, address(executor), abi.encodePacked(address(hook), abi.encode(execData, bytes(""))))
        );
        bytes memory init = abi.encodeCall(
            IKernelInit.initialize, (rootVid, address(hook), "", abi.encodePacked(bytes1(0x00), hookData), cfg)
        );
        return IKernelFactory(factory).createAccount(init, keccak256("leaked-kernel"));
    }

    // ----------------------------------------------------------------------------------------- userOps ------

    function _nonceKey() internal view returns (uint192) {
        // MSA and Safe7579 select the validator from the nonce key's top 20 bytes; Kernel's root validator is key 0.
        if (_host() == Host.KERNEL) return 0;
        return uint192(uint160(address(validator))) << 32;
    }

    function _wrapCallData(bytes memory executeCall) internal pure returns (bytes memory) {
        // Kernel v3.3 requires `executeUserOp` for a validator with a hook (Kernel.sol:269).
        if (_host() == Host.KERNEL) return abi.encodePacked(EXECUTE_USER_OP, executeCall);
        return executeCall;
    }

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(0xe9ae5c53, bytes32(0), abi.encodePacked(target, value, data));
    }

    function _batch(Execution[] memory execs) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(0xe9ae5c53, bytes32(bytes1(0x01)), abi.encode(execs));
    }

    function _op(bytes memory executeCall) internal view returns (PackedUserOperation memory op) {
        op = _opRaw(_wrapCallData(executeCall));
    }

    function _opRaw(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = account;
        op.nonce = ep.getNonce(account, _nonceKey());
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(600_000) << 128) | 1_500_000);
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
        op.signature = _sign(op, hotPk);
    }

    function _sign(PackedUserOperation memory op, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ep.getUserOpHash(op));
        return abi.encodePacked(r, s, v);
    }

    function _resign(PackedUserOperation memory op) internal view {
        op.signature = _sign(op, hotPk);
    }

    struct OpResult {
        bool success;
        uint256 actualGasUsed;
        bytes revertReason;
    }

    /// Submits one op; reverts (FailedOp*) if validation fails; returns the execution outcome.
    function _submit(PackedUserOperation memory op) internal returns (OpResult memory res) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        vm.prank(bundler, bundler);
        ep.handleOps(ops, bundler);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != EP_ADDR) continue;
            if (logs[i].topics[0] == IEntryPointV08.UserOperationEvent.selector) {
                (, bool success,, uint256 gasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                res.success = success;
                res.actualGasUsed = gasUsed;
            } else if (logs[i].topics[0] == IEntryPointV08.UserOperationRevertReason.selector) {
                (, res.revertReason) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
    }

    function _submitOk(PackedUserOperation memory op) internal returns (uint256 gasUsed) {
        OpResult memory r = _submit(op);
        if (!r.success) {
            emit log_named_bytes("revert", r.revertReason);
            revert("userOp execution failed");
        }
        return r.actualGasUsed;
    }

    /// Expects validation to fail with `reason` (EntryPoint FailedOp / FailedOpWithRevert reason string).
    function _expectValidationFail(PackedUserOperation memory op, string memory reason) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        try ep.handleOps(ops, bundler) {
            revert("validation unexpectedly passed");
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            string memory got;
            if (sel == IEntryPointV08.FailedOp.selector) {
                (, got) = abi.decode(_tail(err), (uint256, string));
            } else if (sel == IEntryPointV08.FailedOpWithRevert.selector) {
                (, got,) = abi.decode(_tail(err), (uint256, string, bytes));
            } else {
                revert("not a FailedOp");
            }
            assertEq(got, reason, "EntryPoint reason");
        }
    }

    /// Expects validation to revert in the validator with exactly `inner` (checked where the host passes the revert
    /// data through unchanged: MSA and Kernel; Safe7579 wraps module calls in `execTransactionFromModuleReturnData`).
    function _expectValidationRevert(PackedUserOperation memory op, bytes memory inner) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        try ep.handleOps(ops, bundler) {
            revert("validation unexpectedly passed");
        } catch (bytes memory err) {
            assertEq(bytes4(err), IEntryPointV08.FailedOpWithRevert.selector, "FailedOpWithRevert");
            (, string memory got, bytes memory innerGot) = abi.decode(_tail(err), (uint256, string, bytes));
            assertEq(got, "AA23 reverted");
            if (_host() != Host.SAFE7579) assertEq(innerGot, inner, "validator revert data");
        }
    }

    /// Expects the op to pass validation and fail in execution with `inner` (where the host bubbles it).
    function _expectExecFail(PackedUserOperation memory op, bytes memory inner) internal {
        OpResult memory r = _submit(op);
        assertFalse(r.success, "execution should fail");
        if (_host() == Host.MSA && inner.length != 0) assertEq(r.revertReason, inner, "execution revert data");
    }

    function _tail(bytes memory b) internal pure returns (bytes memory t) {
        t = new bytes(b.length - 4);
        for (uint256 i; i < t.length; ++i) {
            t[i] = b[i + 4];
        }
    }

    // ------------------------------------------------------------------------------------- vault helpers ------

    function _pqSign(bytes32 pk, bytes32 digest) internal view virtual returns (bytes memory) {
        return MockPQVerifier(address(pq)).sign(pk, digest);
    }

    function _vaultNonce() internal view returns (uint256 n) {
        (,,,, n,,,,) = executor.getRoles(account);
    }

    function _recoveryNonce() internal view returns (uint256 n) {
        (,,,,, n,,,) = executor.getRoles(account);
    }

    function _vaultExec(Call[] memory calls, uint256 usd) internal {
        uint256 n = _vaultNonce();
        executor.vaultExec(account, calls, usd, n, _pqSign(vaultPk, executor.hashVaultExec(account, n, calls, usd)));
    }

    function _vaultQueue(Call[] memory calls, uint8 kind) internal returns (bytes32) {
        uint256 n = _vaultNonce();
        return executor.vaultQueue(
            account, calls, kind, n, _pqSign(vaultPk, executor.hashVaultQueue(account, n, calls, kind))
        );
    }

    function _queueAndRun(Call[] memory calls, uint8 kind) internal returns (bytes32 opId) {
        opId = _vaultQueue(calls, kind);
        vm.warp(block.timestamp + 48 hours);
        executor.executeQueued(account, opId, calls);
    }

    function _calls1(address target, uint256 value, bytes memory data) internal pure returns (Call[] memory c) {
        c = new Call[](1);
        c[0] = Call(target, value, data);
    }

    function _hookCall(bytes memory data) internal view returns (Call[] memory) {
        return _calls1(address(hook), 0, data);
    }

    function _available() internal view returns (uint256 a) {
        (a,,) = hook.getBucket(account);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RollingCap} from "../../src/lib/RollingCap.sol";
import {PackedUserOperation, Execution} from "../../src/modules/interfaces/IERC7579Modules.sol";
import {LeakedPolicyHook} from "../../src/modules/LeakedPolicyHook.sol";
import {LeakedHotValidator} from "../../src/modules/LeakedHotValidator.sol";
import {LeakedRoleExecutor} from "../../src/modules/LeakedRoleExecutor.sol";
import {IERC7579AccountView, IAccount4337 as IAccountValidate} from "./hosts/HostInterfaces.sol";
import {LeakedModulesBase} from "./LeakedModulesBase.sol";

contract PermitToken is ERC20Permit {
    constructor() ERC20("PUSD", "PUSD") ERC20Permit("PUSD") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Every policy rule of the 4337 backend, run on each host (MSA, Safe7579, Kernel v3.3).
abstract contract LeakedModulesHostsTest is LeakedModulesBase {
    using MessageHashUtils for bytes32;

    // ---------------------------------------------------------------------------------------- install ------

    function test_modulesInstalled() public view {
        IERC7579AccountView a = IERC7579AccountView(account);
        assertTrue(a.isModuleInstalled(1, address(validator), ""), "validator");
        assertTrue(a.isModuleInstalled(2, address(executor), ""), "executor");
        if (_host() != Host.KERNEL) assertTrue(a.isModuleInstalled(4, address(hook), ""), "hook");
        assertTrue(hook.isInitialized(account) && executor.isInitialized(account) && validator.isInitialized(account));
        assertTrue(account != hotKey, "C3: account is not the hot EOA");
    }

    function test_reinstallRefused() public {
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(AlreadyInitialized.selector, account));
        hook.onInstall(abi.encode(_hookInit()));
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(AlreadyInitialized.selector, account));
        executor.onInstall(abi.encode(_executorInit()));
    }

    // ------------------------------------------------------------------------------------------- hot ------

    function test_hotEthWithinCap() public {
        _submitOk(_op(_single(recipient, 0.1 ether, "")));
        assertEq(recipient.balance, 0.1 ether);
        assertEq(_available(), CAP - 300e6);
    }

    function test_hotErc20Transfer() public {
        _submitOk(_op(_single(address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 200e6)))));
        assertEq(usdc.balanceOf(recipient), 200e6);
        assertEq(_available(), CAP - 200e6);
    }

    function test_hotBatch() public {
        Execution[] memory e = new Execution[](2);
        e[0] = Execution(recipient, 0.05 ether, "");
        e[1] = Execution(address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 100e6)));
        _submitOk(_op(_batch(e)));
        assertEq(_available(), CAP - 250e6);
    }

    function test_overPerTxRejectedInValidation() public {
        // M-b: $600 > perTxMax $500 is refused before it costs gas.
        _expectValidationRevert(
            _op(_single(recipient, 0.2 ether, "")), abi.encodeWithSelector(PerTxMaxExceeded.selector, 600e6, PER_TX)
        );
        assertEq(recipient.balance, 0);
    }

    function test_overCapRejectedInExecution() public {
        _submitOk(_op(_single(recipient, 0.15 ether, ""))); // $450
        _submitOk(_op(_single(recipient, 0.15 ether, ""))); // $450
        uint256 before = recipient.balance;
        // $300 passes validation (static <= perTx, <= cap) but the bucket holds $100: reverts in postCheck.
        _expectExecFail(
            _op(_single(recipient, 0.1 ether, "")), abi.encodeWithSelector(RollingCap.OverCap.selector, 300e6, 100e6)
        );
        assertEq(recipient.balance, before, "nothing moved");
        assertEq(_available(), 100e6);
    }

    function test_capRefills() public {
        _submitOk(_op(_single(recipient, 0.15 ether, "")));
        _submitOk(_op(_single(recipient, 0.15 ether, "")));
        vm.warp(block.timestamp + 12 hours);
        assertEq(_available(), 100e6 + 500e6);
        _submitOk(_op(_single(recipient, 0.15 ether, "")));
    }

    function test_notAllowlistedTarget() public {
        _expectValidationRevert(
            _op(_single(stranger, 0.01 ether, "")), abi.encodeWithSelector(NotAllowed.selector, stranger, bytes4(0))
        );
    }

    function test_transferToNotAllowlistedRecipient() public {
        _expectValidationRevert(
            _op(_single(address(usdc), 0, abi.encodeCall(IERC20.transfer, (stranger, 1e6)))),
            abi.encodeWithSelector(NotAllowed.selector, stranger, IERC20.transfer.selector)
        );
    }

    function test_otherTokenSelectorRejected() public {
        // H2: only `transfer` on an allowlisted token; `approve` without a session is refused.
        _expectValidationRevert(
            _op(_single(address(usdc), 0, abi.encodeCall(IERC20.approve, (recipient, 1e6)))),
            abi.encodeWithSelector(NotAllowed.selector, address(usdc), IERC20.approve.selector)
        );
    }

    function test_hotCannotCallModulesOrSelf() public {
        bytes memory setCap = abi.encodeCall(LeakedPolicyHook.setCap, (account, type(uint96).max, 1, 1, 1));
        _expectValidationRevert(
            _op(_single(address(hook), 0, setCap)),
            abi.encodeWithSelector(NotAllowed.selector, address(hook), LeakedPolicyHook.setCap.selector)
        );
        bytes memory install = abi.encodeCall(IERC7579AccountView.uninstallModule, (2, address(executor), ""));
        _expectValidationRevert(
            _op(_single(account, 0, install)),
            abi.encodeWithSelector(NotAllowed.selector, account, IERC7579AccountView.uninstallModule.selector)
        );
        _expectValidationRevert(
            _op(_single(address(executor), 0, "")), abi.encodeWithSelector(NotAllowed.selector, address(executor), 0)
        );
        // Not `execute` at all: refused by the decoder.
        _expectValidationRevert(_opRaw(_wrapCallData(install)), abi.encodeWithSelector(BadCallData.selector));
    }

    function test_unsupportedModesRejected() public {
        // TRY exec type and DELEGATECALL call type.
        bytes memory tryMode =
            abi.encodeWithSelector(0xe9ae5c53, bytes32(bytes2(0x0001)), abi.encodePacked(recipient, uint256(1), ""));
        _expectValidationRevert(_op(tryMode), abi.encodeWithSelector(UnsupportedMode.selector, bytes32(bytes2(0x0001))));
        bytes memory dc = abi.encodeWithSelector(0xe9ae5c53, bytes32(bytes1(0xff)), abi.encodePacked(recipient, ""));
        _expectValidationRevert(_op(dc), abi.encodeWithSelector(UnsupportedMode.selector, bytes32(bytes1(0xff))));
    }

    function test_nonCanonicalEncodingRejected() public {
        // Offset 0x60 instead of 0x40 (a gap word): the host would still decode it, the validator refuses.
        bytes memory ec = abi.encodePacked(recipient, uint256(0.01 ether));
        bytes memory bad = abi.encodePacked(
            bytes4(0xe9ae5c53), bytes32(0), uint256(0x60), uint256(0), uint256(ec.length), ec, new bytes(12)
        );
        _expectValidationRevert(_op(bad), abi.encodeWithSelector(BadCallData.selector));
    }

    function test_badSignature() public {
        PackedUserOperation memory op = _op(_single(recipient, 0.01 ether, ""));
        (, uint256 otherPk) = makeAddrAndKey("other");
        op.signature = _sign(op, otherPk);
        _expectValidationFail(op, "AA24 signature error");
    }

    function test_feeTooHigh() public {
        PackedUserOperation memory op = _op(_single(recipient, 0.01 ether, ""));
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 100 gwei); // 2.16M gas x 100 gwei > 0.05 ETH
        _resign(op);
        _expectValidationRevert(op, abi.encodeWithSelector(FeeTooHigh.selector));
        op.gasFees = bytes32((uint256(20 gwei) << 128) | 20 gwei); // priority above the 10 gwei bound
        _resign(op);
        _expectValidationRevert(op, abi.encodeWithSelector(FeeTooHigh.selector));
    }

    // ---------------------------------------------------------------------------------- freeze / bunker ------

    function test_guardianFreeze_onlyClearThenExpiry() public {
        vm.prank(guardian);
        executor.guardianFreeze(account);
        _expectValidationRevert(
            _op(_single(recipient, 0.01 ether, "")), abi.encodeWithSelector(FrozenOnlyClear.selector)
        );
        bytes memory clear = _single(address(hook), 0, abi.encodeCall(LeakedPolicyHook.clearExpiredFreeze, (account)));
        // Admitted in validation, but the freeze has not expired: fails in execution.
        _expectExecFail(_op(clear), "");
        vm.warp(block.timestamp + 72 hours);
        _submitOk(_op(clear));
        _submitOk(_op(_single(recipient, 0.01 ether, "")));
        // H5: once per 7 days per guardian.
        vm.prank(guardian);
        vm.expectRevert();
        executor.guardianFreeze(account);
        vm.warp(block.timestamp + 4 days);
        vm.prank(guardian);
        executor.guardianFreeze(account);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        executor.guardianFreeze(account);
    }

    function test_vaultFreezeUnfreeze() public {
        _vaultExec(_hookCall(abi.encodeCall(LeakedPolicyHook.freeze, (account, type(uint48).max))), 0);
        _expectValidationRevert(
            _op(_single(recipient, 0.01 ether, "")), abi.encodeWithSelector(FrozenOnlyClear.selector)
        );
        _vaultExec(_hookCall(abi.encodeCall(LeakedPolicyHook.unfreeze, (account))), 0);
        _submitOk(_op(_single(recipient, 0.01 ether, "")));
    }

    function test_bunker_thenNewHotKey() public {
        _vaultExec(_hookCall(abi.encodeCall(LeakedPolicyHook.enableBunker, (account))), 0);
        _expectValidationRevert(_op(_single(recipient, 0.01 ether, "")), abi.encodeWithSelector(HotDisabled.selector));
        (address newHot, uint256 newPk) = makeAddrAndKey("hot2");
        _vaultExec(_hookCall(abi.encodeCall(LeakedPolicyHook.setHotKey, (account, newHot))), 0);
        PackedUserOperation memory op = _op(_single(recipient, 0.01 ether, ""));
        _expectValidationFail(op, "AA24 signature error"); // old key
        op.signature = _sign(op, newPk);
        _submitOk(op);
    }

    function test_bunkerNeedsRecovery() public {
        // A second account without a recovery key (H6 / I-7).
        ExecutorInit memory xi = _executorInit();
        xi.recoveryPk = bytes32(0);
        address saved = account;
        account = _createAccountSalted(xi);
        Call[] memory c = _hookCall(abi.encodeCall(LeakedPolicyHook.enableBunker, (account)));
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, c, 0));
        vm.expectRevert(
            abi.encodeWithSelector(CallFailed.selector, 0, abi.encodeWithSelector(BunkerNeedsRecovery.selector))
        );
        executor.vaultExec(account, c, 0, n, sig);
        account = saved;
    }

    // ------------------------------------------------------------------------------------- sessions ------

    function _openSessions() internal {
        Call[] memory c = new Call[](2);
        uint48 exp = uint48(block.timestamp + 30 days);
        c[0] = Call(
            address(hook),
            0,
            abi.encodeCall(LeakedPolicyHook.setSession, (account, address(usdc), IERC20.approve.selector, 400e6, exp))
        );
        c[1] = Call(
            address(hook),
            0,
            abi.encodeCall(LeakedPolicyHook.setSession, (account, address(router), router.pull.selector, 400e6, exp))
        );
        // New sessions are loosening: an instant vault batch is refused.
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, c, 0));
        vm.expectRevert(abi.encodeWithSelector(CallFailed.selector, 0, abi.encodeWithSelector(MustQueue.selector)));
        executor.vaultExec(account, c, 0, n, sig);
        _queueAndRun(c, 1);
    }

    function _approvePull(uint256 approveAmt, uint256 pullAmt, address to) internal view returns (bytes memory) {
        Execution[] memory e = new Execution[](2);
        e[0] = Execution(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(router), approveAmt)));
        e[1] = Execution(address(router), 0, abi.encodeCall(router.pull, (IERC20(address(usdc)), pullAmt, to)));
        return _batch(e);
    }

    function test_session_deltaDebit() public {
        _openSessions();
        uint256 before = _available();
        _submitOk(_op(_approvePull(150e6, 150e6, stranger)));
        assertEq(usdc.balanceOf(stranger), 150e6);
        assertEq(_available(), before - 150e6, "bucket debited by the measured delta");
        assertEq(hook.getSession(account, address(router), router.pull.selector).allowanceUsd, 250e6);
    }

    function test_session_standingApprovalReverts() public {
        _openSessions();
        // H4 / I-6: approve 100, router pulls 50: an approval survives the batch.
        _expectExecFail(
            _op(_approvePull(100e6, 50e6, stranger)),
            abi.encodeWithSelector(StandingApproval.selector, address(usdc), address(router))
        );
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_session_sweepAboveAllowanceReverts() public {
        _openSessions();
        // A router that sweeps more than the session allows is caught by the delta.
        _expectExecFail(_op(_approvePull(450e6, 450e6, stranger)), "");
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_session_expiredInExecution() public {
        _openSessions();
        vm.warp(block.timestamp + 31 days);
        // Validation cannot read the clock ([OP-011]): the op is admitted and refused in preCheck.
        _expectExecFail(_op(_approvePull(10e6, 10e6, stranger)), "");
    }

    function test_session_approvalNeedsAllowlistedToken() public {
        // Audit M2: an approval session on a token the delta accounting does not watch is refused.
        MockTokenLike other = new MockTokenLike();
        Call[] memory c = _hookCall(
            abi.encodeCall(
                LeakedPolicyHook.setSession,
                (account, address(other), IERC20.approve.selector, 100e6, uint48(block.timestamp + 30 days))
            )
        );
        _queueAndRun(c, 1);
        _expectValidationRevert(
            _op(_single(address(other), 0, abi.encodeCall(IERC20.approve, (address(router), 1)))),
            abi.encodeWithSelector(NotAllowed.selector, address(other), IERC20.approve.selector)
        );
    }

    // ------------------------------------------------------------------------------------------ 1271 ------

    function _sig1271(bytes memory sig) internal view returns (bytes memory) {
        // MSA and Safe7579 select the validator from the first 20 bytes; Kernel: 0x00 = root validator.
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

    function test_registerHash_and1271() public {
        _queueAndRun(
            _hookCall(abi.encodeCall(LeakedPolicyHook.setTrustedVerifier, (account, address(router), true))), 1
        );
        bytes32 h = keccak256("order");
        bytes memory call =
            abi.encodeCall(LeakedPolicyHook.registerHash, (h, address(usdc), 100e6, uint48(block.timestamp + 1 days)));
        _submitOk(_op(_single(address(hook), 0, call)));
        assertEq(_available(), CAP - 100e6, "registered value debited");
        bool expectOk = _host() != Host.KERNEL; // Kernel rewraps the hash: hot 1271 is off there (audit A3)
        assertEq(_isValid(address(0), h, ""), expectOk, "eth_call (sender 0), empty sig");
        assertEq(_isValid(address(0), h, abi.encodePacked(bytes4(0xdc6b87c9), h)), expectOk, "marker");
        // Audit C1: an opaque registered hash never validates for a token, Permit2 or an untrusted contract;
        // audit A6: nor for a non-zero code-less sender (an EOA transaction looks the same as an eth_call).
        assertFalse(_isValid(stranger, h, ""), "EOA sender");
        assertFalse(_isValid(address(usdc), h, ""), "token caller");
        assertFalse(_isValid(hook.PERMIT2(), h, ""), "permit2");
        assertFalse(_isValid(address(validator), h, ""), "untrusted contract");
        assertEq(_isValid(address(router), h, ""), expectOk, "trusted verifier");
        vm.warp(block.timestamp + 2 days);
        assertFalse(_isValid(address(0), h, ""), "expired");
    }

    function test_C1_poc_selfDeclaredPermitDoesNotDrain() public {
        // PoC (audit C1): a leaked hot key registers the token's permit digest for 1 wei of declared value.
        PermitToken pt = _allowPermitToken();
        address thief = makeAddr("thief");
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = MessageHashUtils.toTypedDataHash(
            pt.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                    account,
                    thief,
                    5000e6,
                    pt.nonces(account),
                    deadline
                )
            )
        );
        _submitOk(
            _op(
                _single(
                    address(hook),
                    0,
                    abi.encodeCall(LeakedPolicyHook.registerHash, (digest, address(pt), 1, uint48(deadline)))
                )
            )
        );
        assertFalse(_isValid(address(pt), digest, ""), "token must not accept an opaque hash");
    }

    function test_registerPermit_boundToToken() public {
        PermitToken pt = _allowPermitToken();
        uint256 deadline = block.timestamp + 1 days;
        uint256 avail = _available();
        _submitOk(
            _op(
                _single(
                    address(hook),
                    0,
                    abi.encodeCall(LeakedPolicyHook.registerPermit, (address(pt), address(router), 300e6, deadline))
                )
            )
        );
        assertEq(_available(), avail - 300e6, "permit value debited");
        bytes32 digest = MessageHashUtils.toTypedDataHash(
            pt.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                    account,
                    address(router),
                    300e6,
                    pt.nonces(account),
                    deadline
                )
            )
        );
        assertEq(hook.registeredHashConsumer(account, digest), address(pt));
        if (_host() != Host.KERNEL) assertTrue(_isValid(address(pt), digest, ""), "the token consumes it");
        assertFalse(_isValid(stranger, digest, ""), "nobody else");
    }

    function _allowPermitToken() internal returns (PermitToken pt) {
        pt = new PermitToken();
        pt.mint(account, 10_000e6);
        _queueAndRun(_hookCall(abi.encodeCall(LeakedPolicyHook.setToken, (account, address(pt), true, 6, 1e6))), 1);
    }

    function _personalSign(bytes32 h, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(keccak256("PersonalSign(bytes prefixed)"), h));
        bytes32 d = validator.accountDomainSeparator(account).toTypedDataHash(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    function test_7739_personalSign_hotVerifierRule() public {
        bytes32 h = keccak256("Sign in to example.org").toEthSignedMessageHash();
        bytes memory sig = _personalSign(h, hotPk);
        bool expectOk = _host() != Host.KERNEL;
        assertEq(_isValid(stranger, h, sig), expectOk, "code-less caller (eth_call / SIWE)");
        // Audit H1: on-chain callers only if vault-trusted; tokens and Permit2 never.
        assertFalse(_isValid(address(router), h, sig), "untrusted contract");
        _queueAndRun(
            _hookCall(abi.encodeCall(LeakedPolicyHook.setTrustedVerifier, (account, address(router), true))), 1
        );
        assertEq(_isValid(address(router), h, sig), expectOk, "trusted verifier");
        assertFalse(_isValid(address(usdc), h, sig), "token");
        assertFalse(_isValid(hook.PERMIT2(), h, sig), "permit2");
        (, uint256 otherPk) = makeAddrAndKey("other");
        assertFalse(_isValid(stranger, h, _personalSign(h, otherPk)), "wrong key");
        // Frozen: nothing.
        vm.prank(guardian);
        executor.guardianFreeze(account);
        assertFalse(_isValid(stranger, h, sig), "frozen");
    }

    function test_7739_typedData() public {
        bytes32 appSep = keccak256(abi.encode(keccak256("EIP712Domain(string name)"), keccak256("App")));
        bytes32 contentsHash = keccak256(abi.encode(keccak256("Login(uint256 nonce)"), uint256(7)));
        bytes32 h = appSep.toTypedDataHash(contentsHash);
        string memory descr = "Login(uint256 nonce)";
        bytes memory domainBytes =
            abi.encode(keccak256("LeakedHotValidator"), keccak256("1"), block.chainid, account, bytes32(0));
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "TypedDataSign(Login contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)",
                "Login(uint256 nonce)"
            )
        );
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, contentsHash, domainBytes));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotPk, appSep.toTypedDataHash(structHash));
        bytes memory sig = abi.encodePacked(r, s, v, appSep, contentsHash, descr, uint16(bytes(descr).length));
        assertEq(_isValid(stranger, h, sig), _host() != Host.KERNEL);
        assertFalse(_isValid(address(usdc), h, sig));
    }

    function test_7739_sentinel() public {
        vm.prank(account);
        assertEq(
            validator.isValidSignatureWithSender(
                stranger, bytes32(0x7739773977397739773977397739773977397739773977397739773977397739), ""
            ),
            bytes4(0x77390001)
        );
    }

    // ----------------------------------------------------------------------------------------- vault ------

    function test_vaultExec_withinThreshold() public {
        _vaultExec(_calls1(stranger, 1 ether, ""), 0); // $3000 <= $5000, any target
        assertEq(stranger.balance, 1 ether);
        assertEq(_available(), CAP, "hot bucket untouched (executor exempt)");
        (uint256 va,,) = executor.getVaultBucket(account);
        assertEq(va, VAULT_THRESHOLD - 3000e6);
    }

    function test_vaultExec_overThreshold_mustQueue() public {
        Call[] memory c = _calls1(stranger, 2 ether, ""); // $6000
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, c, 0));
        vm.expectRevert(abi.encodeWithSelector(VaultOverDailyThreshold.selector, 6000e6, VAULT_THRESHOLD));
        executor.vaultExec(account, c, 0, n, sig);
        bytes32 opId = _vaultQueue(c, 0);
        vm.expectRevert();
        executor.executeQueued(account, opId, c); // before eta
        vm.warp(block.timestamp + 48 hours);
        executor.executeQueued(account, opId, c);
        assertEq(stranger.balance, 2 ether);
        vm.expectRevert(abi.encodeWithSelector(BadOp.selector, opId));
        executor.executeQueued(account, opId, c); // once only (I-5)
    }

    function test_vaultExec_declaredUsdCounts() public {
        Call[] memory c = _calls1(stranger, 0.1 ether, "");
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, c, 6000e6));
        vm.expectRevert(abi.encodeWithSelector(VaultOverDailyThreshold.selector, 6000e6, VAULT_THRESHOLD));
        executor.vaultExec(account, c, 6000e6, n, sig);
    }

    function test_vaultExec_badSigNonceReplay() public {
        Call[] memory c = _calls1(stranger, 0.1 ether, "");
        uint256 n = _vaultNonce();
        bytes32 d = executor.hashVaultExec(account, n, c, 0);
        bytes memory wrongKey = _pqSign(recoveryPk, d);
        bytes memory good = _pqSign(vaultPk, d);
        vm.expectRevert(BadSignature.selector);
        executor.vaultExec(account, c, 0, n, wrongKey); // recovery key is not the vault
        vm.expectRevert(BadSignature.selector);
        executor.vaultExec(account, c, 1, n, good); // usdValue not what was signed
        executor.vaultExec(account, c, 0, n, good);
        vm.expectRevert(abi.encodeWithSelector(BadNonce.selector, n + 1, n));
        executor.vaultExec(account, c, 0, n, good); // replay
    }

    function test_vaultLooseningMustQueue_tighteningInstant() public {
        // Tightening is instant.
        _vaultExec(
            _hookCall(abi.encodeCall(LeakedPolicyHook.setCap, (account, 800e6, 400e6, MAX_FEE_WEI, MAX_PRIO))), 0
        );
        (,, uint256 cap) = hook.getBucket(account);
        assertEq(cap, 800e6);
        // Loosening (raise the cap, add a recipient, re-price lower) must be queued.
        Call[] memory up =
            _hookCall(abi.encodeCall(LeakedPolicyHook.setCap, (account, 2000e6, 500e6, MAX_FEE_WEI, MAX_PRIO)));
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, up, 0));
        vm.expectRevert(abi.encodeWithSelector(CallFailed.selector, 0, abi.encodeWithSelector(MustQueue.selector)));
        executor.vaultExec(account, up, 0, n, sig);
        _queueAndRun(up, 1);
        (,, cap) = hook.getBucket(account);
        assertEq(cap, 2000e6);
        // The executor's own role setters follow the same rule.
        Call[] memory tl = _calls1(
            address(executor), 0, abi.encodeCall(LeakedRoleExecutor.setTimelock, (account, 1 hours, VAULT_THRESHOLD))
        );
        n = _vaultNonce();
        sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, tl, 0));
        vm.expectRevert(abi.encodeWithSelector(CallFailed.selector, 0, abi.encodeWithSelector(MustQueue.selector)));
        executor.vaultExec(account, tl, 0, n, sig);
    }

    function test_policyWritesOnlyByExecutor() public {
        vm.expectRevert(Unauthorized.selector);
        hook.setCap(account, 1, 1, 1, 1);
        vm.prank(account);
        vm.expectRevert(Unauthorized.selector);
        hook.setTarget(account, stranger, true);
        vm.prank(account);
        vm.expectRevert(Unauthorized.selector);
        executor.setGuardian(account, stranger, true);
        vm.prank(account);
        vm.expectRevert(Unauthorized.selector);
        hook.onUninstall("");
        // A config call naming another account is refused.
        Call[] memory c = _hookCall(abi.encodeCall(LeakedPolicyHook.setTarget, (stranger, recipient, false)));
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, c, 0));
        vm.expectRevert(abi.encodeWithSelector(NotAllowed.selector, address(hook), LeakedPolicyHook.setTarget.selector));
        executor.vaultExec(account, c, 0, n, sig);
    }

    function test_moduleChangesOnlyQueued() public {
        Call[] memory c =
            _calls1(account, 0, abi.encodeCall(IERC7579AccountView.uninstallModule, (2, address(executor), "")));
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, c, 0));
        vm.expectRevert(MustQueue.selector);
        executor.vaultExec(account, c, 0, n, sig);
    }

    // -------------------------------------------------------------------------------------- recovery ------

    function _recovery(bytes32 digest) internal view returns (bytes memory) {
        return _pqSign(recoveryPk, digest);
    }

    function test_recoveryCancelsVaultOp() public {
        Call[] memory c = _calls1(stranger, 2 ether, "");
        bytes32 opId = _vaultQueue(c, 0);
        uint256 rn = _recoveryNonce();
        executor.recoveryCancel(account, opId, rn, _recovery(executor.hashRecoveryCancel(account, rn, opId)));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(BadOp.selector, opId));
        executor.executeQueued(account, opId, c);
    }

    function test_recoveryRotation_outranksVault() public {
        Call[] memory c = _calls1(stranger, 2 ether, "");
        bytes32 opId = _vaultQueue(c, 0);
        bytes32 newVault = keccak256("vault-2");
        uint256 rn = _recoveryNonce();
        executor.recoveryStartVaultRotation(
            account, newVault, rn, _recovery(executor.hashRecoveryRotate(account, rn, newVault))
        );
        assertTrue(executor.rotationPending(account));
        // Hot tier frozen; the vault can neither spend, queue, execute queued ops nor unfreeze (I-4).
        _expectValidationRevert(
            _op(_single(recipient, 0.01 ether, "")), abi.encodeWithSelector(FrozenOnlyClear.selector)
        );
        Call[] memory un = _hookCall(abi.encodeCall(LeakedPolicyHook.unfreeze, (account)));
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, un, 0));
        vm.expectRevert(RotationPending.selector);
        executor.vaultExec(account, un, 0, n, sig);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(RotationPending.selector);
        executor.executeQueued(account, opId, c);
        // Nobody can clear the freeze early, not even after its own expiry while the rotation is pending.
        vm.expectRevert(RotationPending.selector);
        hook.clearExpiredFreeze(account);
        vm.expectRevert();
        executor.recoveryFinalizeVaultRotation(account);
        vm.warp(block.timestamp + 5 days);
        executor.recoveryFinalizeVaultRotation(account);
        (,, bytes32 vpk,,,, uint32 epoch,,) = executor.getRoles(account);
        assertEq(vpk, newVault);
        assertEq(epoch, 1);
        (bool frozen,,) = hook.getFreeze(account);
        assertFalse(frozen, "rotation freeze released");
        // Old-epoch ops are void; the old vault key is dead; the new one works.
        vm.expectRevert(abi.encodeWithSelector(BadOp.selector, opId));
        executor.executeQueued(account, opId, c);
        Call[] memory s = _calls1(stranger, 0.1 ether, "");
        n = _vaultNonce();
        sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, s, 0));
        vm.expectRevert(BadSignature.selector);
        executor.vaultExec(account, s, 0, n, sig);
        vaultPk = newVault;
        _vaultExec(s, 0);
        _submitOk(_op(_single(recipient, 0.01 ether, "")));
    }

    // -------------------------------------------------------------------------------------- ERC-7562 ------

    /// [STO-021]: during validation the modules read only storage associated with the account
    /// (`keccak256(account ‖ x) + n`, n <= 128); the validator itself reads none, the executor is not touched.
    function test_erc7562_validationReadsOnlyAssociatedStorage() public {
        _openSessions();
        Execution[] memory e = new Execution[](4);
        e[0] = Execution(recipient, 0.01 ether, "");
        e[1] = Execution(address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 1e6)));
        e[2] = Execution(
            address(hook),
            0,
            abi.encodeCall(
                LeakedPolicyHook.registerHash, (keccak256("x"), address(usdc), 1e6, uint48(block.timestamp + 1 days))
            )
        );
        e[3] = Execution(address(router), 0, abi.encodeCall(router.pull, (IERC20(address(usdc)), 0, stranger)));
        PackedUserOperation memory op = _op(_batch(e));
        bytes32 h = ep.getUserOpHash(op);

        vm.startMappingRecording();
        vm.record();
        vm.prank(EP_ADDR);
        uint256 res = IAccountValidate(account).validateUserOp(op, h, 0);
        assertEq(uint160(res), 0, "validation passes (Kernel packs a validUntil into the upper bits)");
        (bytes32[] memory hookReads,) = vm.accesses(address(hook));
        (bytes32[] memory valReads,) = vm.accesses(address(validator));
        (bytes32[] memory exReads,) = vm.accesses(address(executor));
        assertEq(valReads.length, 0, "validator is stateless");
        assertEq(exReads.length, 0, "executor not read in validation");
        assertGt(hookReads.length, 0);
        for (uint256 i; i < hookReads.length; ++i) {
            assertTrue(_associated(address(hook), hookReads[i]), "hook slot not associated with the account");
        }
        if (_host() == Host.SAFE7579) {
            // The validator's hook-bound check (`isModuleInstalled(4)`) reaches the Safe7579 adapter, a non-entity
            // contract: its reads (`$globalHook[safe]`, the module list) must be account-associated too.
            address adapter = address(
                uint160(uint256(vm.load(account, 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5)))
            );
            (bytes32[] memory adapterReads,) = vm.accesses(adapter);
            assertGt(adapterReads.length, 0);
            for (uint256 i; i < adapterReads.length; ++i) {
                assertTrue(_associated(adapter, adapterReads[i]), "Safe7579 slot not associated with the account");
            }
        }
        vm.stopMappingRecording();
    }

    function _associated(address target, bytes32 slot) internal returns (bool) {
        for (uint256 n; n <= 128; ++n) {
            (bool found, bytes32 key,) = vm.getMappingKeyAndParentOf(target, bytes32(uint256(slot) - n));
            if (found && key == bytes32(uint256(uint160(account)))) return true;
        }
        return false;
    }

    // --------------------------------------------------------------------------------------- helpers ------

    function _createAccountSalted(ExecutorInit memory xi) internal returns (address) {
        // Fresh modules so the second account gets its own host deployment and address.
        return _createAccount(_host(), _hookInit(), xi);
    }
}

/// Plain ERC-20 that is not allowlisted (M2 PoC).
contract MockTokenLike is ERC20 {
    constructor() ERC20("X", "X") {}
}

contract LeakedModulesMSATest is LeakedModulesHostsTest {
    function _host() internal pure override returns (Host) {
        return Host.MSA;
    }

    /// Module changes through a queued vault op (MSA: `executeFromExecutor` self-call to `uninstallModule`).
    function test_uninstallExecutorViaQueue() public {
        Call[] memory c = _calls1(
            account,
            0,
            abi.encodeCall(IERC7579AccountView.uninstallModule, (2, address(executor), abi.encode(address(1), "")))
        );
        _queueAndRun(c, 1);
        assertFalse(IERC7579AccountView(account).isModuleInstalled(2, address(executor), ""));
    }
}

contract LeakedModulesSafe7579Test is LeakedModulesHostsTest {
    function _host() internal pure override returns (Host) {
        return Host.SAFE7579;
    }
}

contract LeakedModulesKernelTest is LeakedModulesHostsTest {
    function _host() internal pure override returns (Host) {
        return Host.KERNEL;
    }
}

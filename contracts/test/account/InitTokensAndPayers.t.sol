// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Vm} from "forge-std/Vm.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {ILeakedAccount} from "../../src/account/ILeakedAccount.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {LeakedAccountRoles} from "../../src/account/LeakedAccountRoles.sol";
import {LeakedAccountStorage} from "../../src/account/LeakedAccountStorage.sol";
import {PQRoleSigner} from "../../src/roles/PQRoleSigner.sol";
import {C13Kat} from "../pq/C13Kat.sol";
import {AccountTestBase} from "./AccountTestBase.sol";
import {MockToken, PermitToken1271} from "./mocks/AccountMocks.sol";

/// 2026-11-06 follow-ups of the extension M3/M4 notes:
/// 1. `InitConfig.tokens`: the initial ERC-20 allowlist, set atomically at initialize with `vaultSetToken`'s price
///    bounds and events, bounded (`MAX_TOKENS`), duplicate-free, contracts only; VERIFY is unchanged (I-2: the slots
///    initialize writes for it are never read by the walker; same VERIFY gas with and without tokens);
/// 2. role payer keys: a derived RecoverySigner carries a Path B payer key (like the vault), so it sends on the
///    public mempool without a stake; payer keys are never the hot key or the tank and differ between the roles.
/// Runs in Open (this contract) and Strict (`InitTokensAndPayersStrictTest`).
contract InitTokensAndPayersTest is AccountTestBase {
    uint256 internal saltN = 1000;
    MockToken internal dai;
    MockToken internal eurc;

    function _mode() internal pure virtual returns (ILeakedAccount.RecipientMode) {
        return ILeakedAccount.RecipientMode.Open;
    }

    function setUp() public virtual override {
        super.setUp();
        dai = new MockToken("DAI", 18);
        eurc = new MockToken("EURC", 6);
    }

    function _tok(address t, uint8 d, uint256 p) internal pure returns (ILeakedAccount.TokenInit memory) {
        return ILeakedAccount.TokenInit(t, d, p);
    }

    function _two() internal view returns (ILeakedAccount.TokenInit[] memory l) {
        l = new ILeakedAccount.TokenInit[](2);
        l[0] = _tok(address(dai), 18, 1 * USD);
        l[1] = _tok(address(eurc), 6, 1_100_000); // $1.10
    }

    function _cfg(ILeakedAccount.TokenInit[] memory l) internal view returns (ILeakedAccount.InitConfig memory c) {
        c = _defaultCfg();
        c.recipientMode = _mode();
        c.tokens = l;
    }

    function _create(ILeakedAccount.InitConfig memory c) internal returns (LeakedAccountImpl) {
        return LeakedAccountImpl(payable(factory.createAccount(bytes32(saltN++), address(impl), _initData(c))));
    }

    function _createReverts(ILeakedAccount.InitConfig memory c, bytes memory err) internal {
        bytes memory init = _initData(c);
        bytes32 salt = bytes32(saltN++);
        vm.expectRevert(err);
        factory.createAccount(salt, address(impl), init);
    }

    function _badAddress(address a) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, a);
    }

    /// A recipient the hot key may pay in this mode: anyone in Open, the tank (allowlisted at initialize) in Strict.
    function _payee() internal view returns (address) {
        return _mode() == ILeakedAccount.RecipientMode.Open ? stranger : tank;
    }

    // ------------------------------------------------------------------------------- 1. initial tokens ------

    function test_initTokens_setAtomically_sameEventsAsVaultSetToken() public {
        ILeakedAccount.InitConfig memory c = _cfg(_two());
        vm.recordLogs();
        LeakedAccountImpl a = _create(c);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        bytes32 topic = ILeakedAccount.TokenConfigured.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(a) || logs[i].topics[0] != topic) continue;
            address t = address(uint160(uint256(logs[i].topics[1])));
            (bool allowed, uint8 d, uint256 p) = abi.decode(logs[i].data, (bool, uint8, uint256));
            assertTrue(allowed);
            if (t == address(dai)) {
                assertEq(d, 18);
                assertEq(p, 1 * USD);
                seen |= 1;
            } else if (t == address(eurc)) {
                assertEq(d, 6);
                assertEq(p, 1_100_000);
                seen |= 2;
            } else {
                assertEq(t, address(0), "only ETH besides the list");
            }
        }
        assertEq(seen, 3, "one TokenConfigured per listed token");
        LeakedAccountRoles r = LeakedAccountRoles(payable(address(a)));
        address[] memory list = r.getTokenList();
        assertEq(list.length, 2);
        assertEq(list[0], address(dai));
        assertEq(list[1], address(eurc));
        ILeakedAccount.TokenCfg memory e = a.getToken(address(eurc));
        assertTrue(e.allowed);
        assertEq(e.decimals, 6);
        assertEq(e.usdPerToken, 1_100_000);
        assertEq(a.quoteUsd(address(eurc), 10e6), 11 * USD);
        assertEq(uint256(a.recipientMode()), uint256(_mode()));
    }

    /// The point of the list: a fresh account pays in a listed token at once (no ≥ 1 h queued `vaultSetToken`), the
    /// payment is priced and debited, and the balance-delta accounting watches the token from block one.
    function test_initTokens_hotPaymentWithoutQueue() public {
        LeakedAccountImpl a = _create(_cfg(_two()));
        eurc.mint(address(a), 1_000e6);
        ILeakedAccount.Call[] memory c = _one(
            ILeakedAccount.Call(address(eurc), 0, abi.encodeWithSelector(IERC20.transfer.selector, _payee(), 10e6))
        );
        vm.prank(address(a));
        a.hotExecute(11 * USD, c);
        assertEq(eurc.balanceOf(_payee()), 10e6);
        (uint256 avail,,,) = a.getBucket();
        assertEq(avail, CAP - 11 * USD, "debited at the initial price");
        // Under-declared: the measured price is binding.
        vm.prank(address(a));
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.DeclaredUsdExceeded.selector, 11 * USD, 10 * USD));
        a.hotExecute(10 * USD, c);
    }

    /// ERC-2612 pre-approval on a fresh account (extension M3): `registerPermit` needs an allowlisted token.
    function test_initTokens_registerPermitWithoutQueue() public {
        PermitToken1271 p = new PermitToken1271("PUSD");
        ILeakedAccount.TokenInit[] memory l = new ILeakedAccount.TokenInit[](1);
        l[0] = _tok(address(p), 18, 1 * USD);
        LeakedAccountImpl a = _create(_cfg(l));
        uint256 deadline = block.timestamp + 1 hours;
        ILeakedAccount.Call[] memory c = _one(
            ILeakedAccount.Call(
                address(a), 0, abi.encodeCall(LeakedAccountImpl.registerPermit, (address(p), alice, 5 ether, deadline))
            )
        );
        vm.prank(address(a));
        a.hotExecute(5 * USD, c);
        bytes32 digest = p.permitDigest(address(a), alice, 5 ether, deadline);
        assertEq(a.registeredHashConsumer(digest), address(p));
        p.permit(address(a), alice, 5 ether, deadline, "");
        assertEq(p.allowance(address(a), alice), 5 ether);
    }

    function test_initTokens_rejects_zero_codeless_hot_tank() public {
        address[4] memory bad = [address(0), makeAddr("eoa"), hot, tank];
        for (uint256 i; i < 4; ++i) {
            ILeakedAccount.TokenInit[] memory l = _two();
            l[1].token = bad[i];
            _createReverts(_cfg(l), _badAddress(bad[i]));
        }
    }

    /// The account's own address and a role signer: refused even when they have code (explicit, deployed signers).
    function test_initTokens_rejects_account_and_roleSigners() public {
        ILeakedAccount.InitConfig memory c = _cfg(_two());
        bytes memory probe = _initData(c);
        bytes32 salt = bytes32(saltN);
        address predicted = factory.predictAccount(salt, address(impl), probe);
        // The predicted address depends on the list, so a self-listing is refused as code-less or as itself.
        c.tokens[0].token = predicted;
        _createReverts(c, _badAddress(predicted));

        // Explicit mode with deployed (contract) signers named as tokens.
        ILeakedAccount.InitConfig memory e = _explicitCfg(address(dai), address(eurc));
        e.recipientMode = _mode();
        e.tokens = _two();
        _createReverts(e, _badAddress(address(dai)));
        e.tokens = new ILeakedAccount.TokenInit[](1);
        e.tokens[0] = _tok(address(eurc), 6, 1 * USD);
        _createReverts(e, _badAddress(address(eurc)));
    }

    function test_initTokens_rejects_duplicate() public {
        ILeakedAccount.TokenInit[] memory l = new ILeakedAccount.TokenInit[](3);
        l[0] = _tok(address(dai), 18, 1 * USD);
        l[1] = _tok(address(eurc), 6, 1 * USD);
        l[2] = _tok(address(dai), 18, 2 * USD); // same token, any price
        _createReverts(_cfg(l), abi.encodeWithSelector(ILeakedAccount.DuplicateToken.selector, address(dai)));
    }

    function test_initTokens_rejects_badPriceOrDecimals() public {
        ILeakedAccount.TokenInit[] memory l = _two();
        l[0].usdPerToken = 0;
        _createReverts(_cfg(l), abi.encodeWithSelector(ILeakedAccount.BadConfig.selector));
        l = _two();
        l[1].decimals = 37;
        _createReverts(_cfg(l), abi.encodeWithSelector(ILeakedAccount.BadConfig.selector));
        l[1].decimals = 36; // the setter's bound, inclusive
        _create(_cfg(l));
    }

    function test_initTokens_boundedByMaxTokens() public {
        uint256 max = impl.MAX_TOKENS();
        ILeakedAccount.TokenInit[] memory l = new ILeakedAccount.TokenInit[](max + 1);
        for (uint256 i; i <= max; ++i) {
            l[i] = _tok(address(new MockToken("T", 6)), 6, 1 * USD);
        }
        _createReverts(_cfg(l), abi.encodeWithSelector(ILeakedAccount.TooManyTokens.selector));
        assembly ("memory-safe") {
            mstore(l, max)
        }
        LeakedAccountImpl a = _create(_cfg(l));
        assertEq(LeakedAccountRoles(payable(address(a))).getTokenList().length, max);
        // Full: the vault cannot add a 17th (the setter's bound holds after initialize too).
        (address v,,,,) = LeakedAccountRoles(payable(address(a))).getRoles();
        ILeakedAccount.Call[] memory q = _one(
            ILeakedAccount.Call(
                address(a),
                0,
                abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(new MockToken("X", 6)), true, 6, USD))
            )
        );
        vm.prank(v);
        bytes32 op = LeakedAccountRoles(payable(address(a))).vaultQueue(q, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert();
        LeakedAccountRoles(payable(address(a))).executeQueued(op, q);
    }

    /// After initialize the list is ordinary vault state: removal and a price raise are instant, a lower price queued.
    function test_initTokens_thenVaultSetterRulesApply() public {
        LeakedAccountImpl a = _create(_cfg(_two()));
        LeakedAccountRoles r = LeakedAccountRoles(payable(address(a)));
        (address v,,,,) = r.getRoles();
        vm.startPrank(v);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        r.vaultSetToken(address(dai), true, 18, USD / 2);
        r.vaultSetToken(address(dai), true, 18, 2 * USD);
        r.vaultSetToken(address(eurc), false, 0, 0);
        vm.stopPrank();
        assertEq(r.getTokenList().length, 1);
        assertFalse(a.getToken(address(eurc)).allowed);
    }

    /// Fuzz: any list of up to 20 entries over a pool of 8 tokens (so duplicates are common) succeeds iff it has at
    /// most `MAX_TOKENS` entries, no duplicate and in-bound prices; on success the stored state is exactly the list.
    function testFuzz_initTokens_outcome(uint8 n, uint256 seed, bool badPrice) public {
        n = uint8(bound(n, 0, 20));
        address[8] memory pool;
        for (uint256 i; i < 8; ++i) {
            pool[i] = address(new MockToken("P", 6));
        }
        ILeakedAccount.TokenInit[] memory l = new ILeakedAccount.TokenInit[](n);
        bool dup;
        for (uint256 i; i < n; ++i) {
            address t = pool[uint256(keccak256(abi.encode(seed, i))) % 8];
            for (uint256 j; j < i; ++j) {
                if (l[j].token == t) dup = true;
            }
            l[i] = _tok(t, uint8(seed >> (i % 200)) % 37, 1 + (seed % 1e12));
        }
        if (badPrice && n != 0) l[n - 1].usdPerToken = 0;
        ILeakedAccount.InitConfig memory c = _cfg(l);
        bytes memory init = _initData(c);
        bytes32 salt = bytes32(saltN++);
        try factory.createAccount(salt, address(impl), init) returns (address acct) {
            assertTrue(n <= 16 && !dup && !(badPrice && n != 0), "accepted a bad list");
            address[] memory list = LeakedAccountRoles(payable(acct)).getTokenList();
            assertEq(list.length, n);
            for (uint256 i; i < n; ++i) {
                assertEq(list[i], l[i].token);
                ILeakedAccount.TokenCfg memory tc = LeakedAccountImpl(payable(acct)).getToken(l[i].token);
                assertTrue(tc.allowed);
                assertEq(tc.decimals, l[i].decimals);
                assertEq(tc.usdPerToken, l[i].usdPerToken);
            }
        } catch {
            assertTrue(n > 16 || dup || (badPrice && n != 0), "refused a good list");
        }
    }

    /// I-2 with initial tokens: everything initialize writes for the list (the token configs and `tokenList`) lies
    /// outside the VERIFY slots, VERIFY reads only slots 0-2 (and the implementation slot), and VERIFY costs exactly
    /// the same gas as on the account without a list.
    function test_I2_initTokensSlotsDisjointFromVerify_sameGas() public {
        // Same-shape accounts, both created in this test (equally warm), measured after a warm-up of the helpers.
        LeakedAccountImpl plain = _create(_cfg(new ILeakedAccount.TokenInit[](0)));
        ILeakedAccount.InitConfig memory c = _cfg(_two());
        vm.record();
        LeakedAccountImpl a = _create(c);
        (, bytes32[] memory iwrites) = vm.accesses(address(a));
        uint256 base = uint256(LeakedAccountStorage.SLOT);
        bytes32 tokenSlot = keccak256(abi.encode(address(eurc), base + 7)); // tokens[eurc] (mapping at base+7)
        bool wroteTokenCfg;
        for (uint256 i; i < iwrites.length; ++i) {
            if (iwrites[i] == tokenSlot) wroteTokenCfg = true;
        }
        assertTrue(wroteTokenCfg, "initialize wrote tokens[eurc] (layout probe)");

        account = a;
        roles = LeakedAccountRoles(payable(address(a)));
        eurc.mint(address(a), 1_000e6);
        _verifyGas(account); // warm-up (FrameSim helpers)
        uint256 gasBase = _verifyGas(plain);
        uint256 gasTokens = _verifyGas(a);
        assertEq(gasTokens, gasBase, "VERIFY gas changed with an initial token list");

        _beginHotTx(_hotData(2 * USD, _one(_eurcTransfer(_payee(), 1e6))));
        _signHotTx();
        vm.record();
        simEnter(0);
        vm.prank(ENTRY_POINT);
        (bool ok,) = address(a).call(_verifyData());
        simLeave(0, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertTrue(ok);
        (bytes32[] memory reads, bytes32[] memory vwrites) = vm.accesses(address(a));
        assertEq(vwrites.length, 0, "VERIFY wrote storage");
        for (uint256 i; i < reads.length; ++i) {
            uint256 s = uint256(reads[i]);
            assertTrue(
                s == base || s == base + 1 || s == base + 2 || reads[i] == ERC1967Utils.IMPLEMENTATION_SLOT,
                "VERIFY read an execution-side slot"
            );
            for (uint256 j; j < iwrites.length; ++j) {
                uint256 w = uint256(iwrites[j]);
                if (w == base || w == base + 1 || w == base + 2 || iwrites[j] == ERC1967Utils.IMPLEMENTATION_SLOT) {
                    continue; // VERIFY's own config slots (initialize sets them, as before)
                }
                assertTrue(reads[i] != iwrites[j], "VERIFY read a slot initialize wrote for the token list");
            }
        }
        // The SENDER frame's payment goes through with the listed token (the walker never decoded it).
        vm.prank(address(a));
        a.hotExecute(2 * USD, _one(_eurcTransfer(_payee(), 1e6)));
        assertEq(eurc.balanceOf(_payee()), 1e6);
    }

    function _eurcTransfer(address to, uint256 amount) internal view returns (ILeakedAccount.Call memory) {
        return ILeakedAccount.Call(address(eurc), 0, abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
    }

    /// Gas of one VERIFY frame of the canonical hot shape on `a` (a payment to the tank, allowlisted in both modes).
    function _verifyGas(LeakedAccountImpl a) internal returns (uint256 used) {
        LeakedAccountImpl saved = account;
        account = a;
        _beginHotTx(_hotData(1 * USD, _one(_ethSend(tank, 1 wei))));
        _signHotTx();
        simEnter(0);
        vm.prank(ENTRY_POINT);
        uint256 g = gasleft();
        (bool ok,) = address(a).call(_verifyData());
        used = g - gasleft();
        simLeave(0, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertTrue(ok, "VERIFY");
        account = saved;
    }

    // ------------------------------------------------------------------------------------ 2. payer keys ------

    function test_payerKey_neverHotKeyOrTank() public {
        ILeakedAccount.InitConfig memory c = _cfg(_two());
        c.vault.payerKey = hot;
        _createReverts(c, _badAddress(hot));
        c = _cfg(_two());
        c.vault.payerKey = tank;
        _createReverts(c, _badAddress(tank));
        c = _cfg(_two());
        c.recovery.payerKey = hot;
        _createReverts(c, _badAddress(hot));
        c = _cfg(_two());
        c.recovery.payerKey = tank;
        _createReverts(c, _badAddress(tank));
    }

    function test_payerKey_distinctBetweenRoles() public {
        ILeakedAccount.InitConfig memory c = _cfg(_two());
        c.recovery.payerKey = vaultPayer;
        _createReverts(c, _badAddress(vaultPayer));
        c.recovery.payerKey = makeAddr("recoveryDevicePayer");
        _create(c);
        // Both zero (Path A only) stays allowed.
        c.vault.payerKey = address(0);
        c.recovery.payerKey = address(0);
        _create(c);
    }

    /// The derivation commits to the recovery payer key: the derived RecoverySigner is the clone created with it, and
    /// `RoleSignerDerived` logs it so anyone can deploy the clone lazily.
    function test_recoveryPayerKey_inDerivation() public {
        address rp = makeAddr("recoveryDevicePayer");
        ILeakedAccount.InitConfig memory c = _cfg(_two());
        c.recovery.payerKey = rp;
        bytes memory init = _initData(c);
        bytes32 salt = bytes32(saltN++);
        address predicted = factory.predictAccount(salt, address(impl), init);
        vm.expectEmit(true, true, true, true, predicted);
        emit ILeakedAccount.RoleSignerDerived(
            2,
            _derivedSigner(predicted, 2, RECOVERY_PK, rp),
            address(signerFactory),
            bytes32(0),
            RECOVERY_PK,
            address(pqVerifier),
            rp
        );
        address a = factory.createAccount(salt, address(impl), init);
        (, address r,,,) = LeakedAccountRoles(payable(a)).getRoles();
        assertEq(r, _derivedSigner(a, 2, RECOVERY_PK, rp));
        assertTrue(r != _derivedSigner(a, 2, RECOVERY_PK, address(0)), "payer key is part of the address");
        PQRoleSigner s = PQRoleSigner(
            payable(signerFactory.createRoleSigner(bytes32(0), 2, a, RECOVERY_PK, address(pqVerifier), rp))
        );
        assertEq(address(s), r);
        assertEq(s.payerKey(), rp);
        assertEq(s.role(), 2);
    }
}

/// The recovery's Path B end to end with a real C13 signature (KAT set C): a derived RecoverySigner with a payer key
/// (entry 1, SECP256K1, on the recovery device) cancels a queued vault loosening; no stake, no Path A. Without a
/// payer key the same transaction is refused in VERIFY (`PathBDisabled`).
contract RecoveryPathBTest is AccountTestBase {
    C13Verifier internal c13;
    C13Kat.Vector internal kat;
    LeakedAccountImpl internal acct;
    LeakedAccountRoles internal acctRoles;
    address internal recPayer;
    uint256 internal recPayerPk;
    bytes32 internal constant SALT = keccak256("recovery-path-b");

    function _create(address payer) internal returns (address vaultS, address recS) {
        ILeakedAccount.InitConfig memory c = _defaultCfg();
        c.recovery = ILeakedAccount.RoleSignerParams(SALT, kat.pk, address(c13), payer);
        acct = LeakedAccountImpl(payable(factory.createAccount(SALT, address(impl), _initData(c))));
        acctRoles = LeakedAccountRoles(payable(address(acct)));
        (vaultS, recS,,,) = acctRoles.getRoles();
    }

    function setUp() public override {
        super.setUp();
        kat = C13Kat.load(1);
        c13 = new C13Verifier();
        (recPayer, recPayerPk) = makeAddrAndKey("recoveryDevicePayer");
        simAttach(address(signerFactory.implementation()));
    }

    function _queueLoosening(address vaultS) internal returns (bytes32 opId) {
        ILeakedAccount.Call[] memory q = _one(
            ILeakedAccount.Call(
                address(acct), 0, abi.encodeCall(LeakedAccountRoles.vaultSetCap, (CAP * 2, PER_TX, MAX_FEE_WEI, 4))
            )
        );
        vm.prank(vaultS);
        opId = acctRoles.vaultQueue(q, 1);
    }

    function _pathB(address signer, bytes memory body) internal {
        simBegin(signer);
        simSetFees(1 gwei, 2 gwei, 0.01 ether);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), 90_000, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), 500_000, 0, body);
        simAddArbitrary(kat.sig);
        simAddSecp256k1(recPayer);
        simSignSecp256k1(1, recPayerPk);
    }

    function test_recovery_pathB_cancelsQueuedLoosening() public {
        (address vaultS, address recS) = _create(recPayer);
        bytes32 opId = _queueLoosening(vaultS);
        PQRoleSigner s = PQRoleSigner(
            payable(signerFactory.createRoleSigner(SALT, 2, address(acct), kat.pk, address(c13), recPayer))
        );
        assertEq(address(s), recS, "lazily deployed at the derived address");
        vm.deal(address(s), 1 ether);
        _pathB(
            address(s),
            abi.encodeCall(
                PQRoleSigner.executePQ, (0, address(acct), abi.encodeCall(LeakedAccountRoles.recoveryCancel, (opId)))
            )
        );
        SimResult memory r = simRunValid();
        assertEq(r.payer, address(s), "the RecoverySigner pays for itself");
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(uint256(acctRoles.getQueued(opId).state), uint256(ILeakedAccount.OpState.CANCELLED));
    }

    function test_recovery_withoutPayerKey_pathBDisabled() public {
        (address vaultS,) = _create(address(0));
        bytes32 opId = _queueLoosening(vaultS);
        PQRoleSigner s = PQRoleSigner(
            payable(signerFactory.createRoleSigner(SALT, 2, address(acct), kat.pk, address(c13), address(0)))
        );
        vm.deal(address(s), 1 ether);
        _pathB(
            address(s),
            abi.encodeCall(
                PQRoleSigner.executePQ, (0, address(acct), abi.encodeCall(LeakedAccountRoles.recoveryCancel, (opId)))
            )
        );
        SimResult memory r = simRun();
        assertFalse(r.valid, "no payer key: Path B refused in VERIFY");
        assertEq(uint256(acctRoles.getQueued(opId).state), uint256(ILeakedAccount.OpState.PENDING));
    }
}

contract InitTokensAndPayersStrictTest is InitTokensAndPayersTest {
    function _mode() internal pure override returns (ILeakedAccount.RecipientMode) {
        return ILeakedAccount.RecipientMode.Strict;
    }
}

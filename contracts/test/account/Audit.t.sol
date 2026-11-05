// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC7739Utils} from "@openzeppelin/contracts/utils/cryptography/draft-ERC7739Utils.sol";
import {ILeakedAccount} from "../../src/account/ILeakedAccount.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {LeakedAccountRoles} from "../../src/account/LeakedAccountRoles.sol";
import {LeakedAccountStorage} from "../../src/account/LeakedAccountStorage.sol";
import {AccountTestBase} from "./AccountTestBase.sol";
import {PermitToken1271, MockRouter, Verifier1271} from "./mocks/AccountMocks.sol";

/// Security-audit regressions (2026-11-06). Each test names the finding it pins; every one of them failed on the
/// code as first implemented (the leaked hot key could do what the test forbids).
contract AuditTest is AccountTestBase {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant BAD = 0xffffffff;
    bytes4 internal constant APPROVE = IERC20.approve.selector;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address internal attacker = makeAddr("attacker"); // holds the leaked hot key, nothing else
    PermitToken1271 internal pusd; // allowlisted, permit via 1271 (USDC-like)
    PermitToken1271 internal dai; // held by the account, NOT allowlisted
    Verifier1271 internal dapp;

    function setUp() public override {
        super.setUp();
        pusd = new PermitToken1271("pUSD");
        dai = new PermitToken1271("DAI");
        dapp = new Verifier1271();
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetToken, (address(pusd), true, 18, 1 * USD)));
        pusd.mint(address(account), 90_000 ether);
        dai.mint(address(account), 90_000 ether);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _personal(uint256 pk, bytes32 hash) internal view returns (bytes memory) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("LEAKED"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("PersonalSign(bytes prefixed)"), hash));
        return _sign(pk, MessageHashUtils.toTypedDataHash(ds, structHash));
    }

    /// The hot key's ERC-7739 TypedDataSign envelope over a token's ERC-2612 `Permit` typed data.
    function _permitSig7739(PermitToken1271 token, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 appSeparator = token.DOMAIN_SEPARATOR();
        bytes32 contentsHash = keccak256(
            abi.encode(
                token.PERMIT_TYPEHASH(), address(account), spender, value, token.nonces(address(account)), deadline
            )
        );
        string memory descr = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "TypedDataSign(Permit contents,string name,string version,uint256 chainId,address verifyingContract,",
                "bytes32 salt)",
                descr
            )
        );
        bytes memory domainBytes =
            abi.encode(keccak256("LEAKED"), keccak256("1"), block.chainid, address(account), bytes32(0));
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, contentsHash, domainBytes));
        bytes memory raw = _sign(hotPk, MessageHashUtils.toTypedDataHash(appSeparator, structHash));
        return ERC7739Utils.encodeTypedDataSig(raw, appSeparator, contentsHash, descr);
    }

    // ------------------------------------------------------------------ C1: registerHash with a lying amount ------

    /// A leaked hot key registers a token's permit digest for 90,000 tokens while declaring an amount of 1 wei: the
    /// token must not honour that hash (the debit is self-declared; the contract cannot read the hash's value).
    function test_C1_opaqueRegisteredHash_notHonouredByTokenOrPermit2() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = pusd.permitDigest(address(account), attacker, 90_000 ether, deadline);
        ILeakedAccount.Call memory reg =
            _selfCall(abi.encodeCall(LeakedAccountImpl.registerHash, (digest, address(pusd), 1, uint48(deadline))));
        _hot(1, _one(reg)); // debit: 1 wei of pUSD = $0.000001
        assertEq(account.registeredHashExpiry(digest), uint48(deadline));

        vm.prank(address(pusd));
        assertEq(account.isValidSignature(digest, ""), BAD, "token asks: opaque registration refused");
        vm.prank(PERMIT2);
        assertEq(account.isValidSignature(digest, ""), BAD, "Permit2 asks: refused");
        vm.expectRevert("bad sig");
        pusd.permit(address(account), attacker, 90_000 ether, deadline, "");
        vm.prank(attacker);
        vm.expectRevert();
        pusd.transferFrom(address(account), attacker, 90_000 ether);
        assertEq(pusd.balanceOf(attacker), 0);
        // the same hash stays usable where it is harmless: an off-chain (eth_call) verifier
        vm.prank(address(0));
        assertEq(account.isValidSignature(digest, ""), MAGIC);
    }

    /// The sound replacement: `registerPermit` computes the ERC-2612 digest on chain, so the debit is the permit's
    /// own value, and only that token may consume it.
    function test_C1_registerPermit_bindsValueAndToken() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = pusd.permitDigest(address(account), alice, 50 ether, deadline);
        ILeakedAccount.Call memory reg =
            _selfCall(abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, 50 ether, deadline)));
        vm.expectEmit(address(account));
        emit ILeakedAccount.HashRegistered(digest, address(pusd), 50 ether, uint48(deadline));
        _hot(50 * USD, _one(reg));
        assertEq(_bucketAvailable(), CAP - 50 * USD, "debited at the permit's value");
        assertEq(account.registeredHashConsumer(digest), address(pusd));

        bytes memory marker = abi.encodePacked(account.REGISTERED_MARKER(), digest);
        vm.prank(address(pusd));
        assertEq(account.isValidSignature(digest, ""), MAGIC);
        vm.prank(address(pusd));
        assertEq(account.isValidSignature(digest, marker), MAGIC);
        vm.prank(address(0));
        assertEq(account.isValidSignature(digest, ""), BAD, "bound to the token only");
        vm.prank(PERMIT2);
        assertEq(account.isValidSignature(digest, ""), BAD);

        pusd.permit(address(account), alice, 50 ether, deadline, "");
        vm.prank(alice);
        pusd.transferFrom(address(account), alice, 50 ether);
        assertEq(pusd.balanceOf(alice), 50 ether);
        // a second permit for the same (spender, value) is a new nonce: not registered
        assertEq(account.registeredHashExpiry(pusd.permitDigest(address(account), alice, 50 ether, deadline)), 0);
    }

    function test_C1_registerPermit_reverts() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        vm.expectRevert(ILeakedAccount.OnlySelf.selector);
        account.registerPermit(address(pusd), alice, 1, deadline);
        vm.prank(address(account));
        vm.expectRevert(ILeakedAccount.NotInHotBatch.selector);
        account.registerPermit(address(pusd), alice, 1, deadline);
        // unpriced token (not allowlisted): no debit is possible, so no registration
        ILeakedAccount.Call memory c =
            _selfCall(abi.encodeCall(LeakedAccountImpl.registerPermit, (address(dai), alice, 1, deadline)));
        vm.expectRevert(
            abi.encodeWithSelector(
                ILeakedAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(ILeakedAccount.TokenNotAllowed.selector, address(dai))
            )
        );
        _hot(1 * USD, _one(c));
        // past deadline
        c = _selfCall(
            abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, 1, vm.getBlockTimestamp()))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                ILeakedAccount.CallFailed.selector, 0, abi.encodeWithSelector(ILeakedAccount.BadExpiry.selector)
            )
        );
        _hot(1 * USD, _one(c));
        // over the per-tx bound / bucket: an "infinite" permit cannot be registered
        c = _selfCall(
            abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, type(uint256).max, deadline))
        );
        vm.expectRevert();
        _hot(type(uint256).max, _one(c));
        // a long deadline is clamped to MAX_REGISTERED_TTL
        c = _selfCall(abi.encodeCall(LeakedAccountImpl.registerPermit, (address(pusd), alice, 1, deadline + 365 days)));
        _hot(1 * USD, _one(c));
        bytes32 d = pusd.permitDigest(address(account), alice, 1, deadline + 365 days);
        assertEq(account.registeredHashExpiry(d), uint48(vm.getBlockTimestamp() + 30 days));
    }

    // ------------------------------------------------- H1: 7739 "any domain" vs value-moving verifiers ------

    /// A token the account holds but the vault never allowlisted (so never priced, never denied) accepts 1271
    /// permits: with "any domain" the leaked hot key signs its permit through the 7739 envelope and drains it.
    function test_H1_nonAllowlistedPermitToken_notSignableByHotKey() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _permitSig7739(dai, attacker, 90_000 ether, deadline);
        bytes32 digest = dai.permitDigest(address(account), attacker, 90_000 ether, deadline);
        vm.prank(address(dai));
        assertEq(account.isValidSignature(digest, sig), BAD, "a contract verifier the vault never trusted");
        vm.expectRevert("bad sig");
        dai.permit(address(account), attacker, 90_000 ether, deadline, sig);
        assertEq(dai.allowance(address(account), attacker), 0);
    }

    /// What stays open without the vault: verification by eth_call (SIWE and other off-chain checks run with a
    /// code-less `from`), and the 7739 support sentinel for anyone. On-chain contract verifiers need the vault.
    function test_H1_hotKey7739_offChainOnly_unlessTrusted() public {
        bytes32 h = keccak256("Sign in to example.org");
        bytes memory sig = _personal(hotPk, h);
        vm.prank(address(0));
        assertEq(account.isValidSignature(h, sig), MAGIC, "eth_call from 0x0");
        vm.prank(stranger);
        assertEq(account.isValidSignature(h, sig), MAGIC, "eth_call from an EOA");
        assertEq(dapp.check(address(account), h, sig), BAD, "contract verifier: not trusted");
        assertEq(
            dapp.check(
                address(account), bytes32(0x7739773977397739773977397739773977397739773977397739773977397739), ""
            ),
            bytes4(0x77390001)
        );

        vm.prank(vault);
        vm.expectRevert(ILeakedAccount.MustQueue.selector);
        roles.vaultSetTrustedVerifier(address(dapp), true);
        ILeakedAccount.Call[] memory q =
            _one(_selfCall(abi.encodeCall(LeakedAccountRoles.vaultSetTrustedVerifier, (address(dapp), true))));
        vm.prank(vault);
        bytes32 op = roles.vaultQueue(q, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectEmit(address(account));
        emit ILeakedAccount.TrustedVerifierSet(address(dapp), true);
        roles.executeQueued(op, q);
        assertTrue(roles.isTrustedVerifier(address(dapp)));
        assertEq(dapp.check(address(account), h, sig), MAGIC, "trusted verifier");
        // the deny list still wins over trust (a trusted verifier that turns out to move value)
        vm.prank(vault);
        roles.vaultSetValueVerifier(address(dapp), true);
        assertEq(dapp.check(address(account), h, sig), BAD);
        vm.prank(vault);
        roles.vaultSetTrustedVerifier(address(dapp), false); // untrusting is instant
        assertFalse(roles.isTrustedVerifier(address(dapp)));
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(ILeakedAccount.BadAddress.selector, address(account)));
        roles.vaultSetTrustedVerifier(address(account), false);
    }

    // ------------------------------------------------------ M2: approvals via sessions on unmonitored assets ------

    // ------------------------------------------------------------- M1: fee exposure is MAX_COST, not limits ------

    /// On the per-gas profile the payer is charged `maxFeePerGas x (intrinsic + sum of limits)`: the bound must be
    /// on TXPARAM(MAX_COST), or a batch with megabytes of calldata burns the tank far beyond `maxFeeWeiPerTx`.
    function test_M1_feeBoundUsesMaxCost() public {
        _beginHotTx(_hotData(1 * USD, _one(_usdcTransfer(alice, 1 * USD))));
        // frame limits x maxFee = 410k x 1 gwei = 0.00041 ETH, but the tx's max cost is 0.06 ETH > 0.05 bound.
        simSetFees(1 gwei, 1 gwei, 0.06 ether);
        _signHotTx();
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), ILeakedAccount.FeeTooHigh.selector);
    }

    // --------------------------------------------------------------- L1: value-bearing frames before VERIFY ------

    function test_L1_frameBeforeWithValueRefused() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simAddFrame(MODE_DEFAULT, 0, address(factory), 50_000, 0, 1 wei, "");
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _hotData(1 * USD, _one(_usdcTransfer(alice, 1 * USD))));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        simEnter(1);
        vm.prank(ENTRY_POINT);
        (bool ok, bytes memory ret) = address(account).call(_verifyData());
        simLeave(1, STATUS_FAILED);
        assertFalse(ok);
        assertEq(bytes4(ret), ILeakedAccount.BadFrameBefore.selector);
    }

    // ------------------------------------------------------------------------- I-2: VERIFY reads vs hot writes ------

    /// The slots VERIFY reads are the three packed policy slots (and the proxy's implementation slot); a hot batch
    /// writes none of them (C4: nothing a leaked hot key does can invalidate its own pending transactions).
    function test_I2_verifyReadsOnlyRoleWrittenSlots() public {
        _beginHotTx(_hotData(1 * USD, _one(_usdcTransfer(alice, 1 * USD))));
        _signHotTx();
        vm.record();
        simEnter(0);
        vm.prank(ENTRY_POINT);
        (bool ok,) = address(account).call(_verifyData());
        simLeave(0, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertTrue(ok);
        (bytes32[] memory reads, bytes32[] memory vwrites) = vm.accesses(address(account));
        assertEq(vwrites.length, 0, "VERIFY wrote storage");
        assertGt(reads.length, 0);
        uint256 base = uint256(LeakedAccountStorage.SLOT);
        for (uint256 i; i < reads.length; ++i) {
            uint256 s = uint256(reads[i]);
            assertTrue(
                s == base || s == base + 1 || s == base + 2 || reads[i] == ERC1967Utils.IMPLEMENTATION_SLOT,
                "VERIFY read an execution-side slot"
            );
        }

        vm.record();
        uint48 exp = uint48(vm.getBlockTimestamp() + 1 hours);
        ILeakedAccount.Call[] memory c = new ILeakedAccount.Call[](3);
        c[0] = _usdcTransfer(alice, 1 * USD);
        c[1] = _ethSend(alice, 1 wei);
        c[2] = _selfCall(abi.encodeCall(LeakedAccountImpl.registerHash, (keccak256("h"), address(usdc), 1, exp)));
        _hot(2 * USD, c);
        (, bytes32[] memory hwrites) = vm.accesses(address(account));
        assertGt(hwrites.length, 0);
        for (uint256 i; i < hwrites.length; ++i) {
            for (uint256 j; j < reads.length; ++j) {
                assertTrue(hwrites[i] != reads[j], "hot batch wrote a VERIFY-read slot");
            }
        }
    }
}

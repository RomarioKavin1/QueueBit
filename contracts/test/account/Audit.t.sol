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

    // ------------------------------------------------- H1: 7739 "any domain" vs value-moving verifiers ------

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

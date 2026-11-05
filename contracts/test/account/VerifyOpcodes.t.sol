// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {LeakedAccountRoles} from "../../src/account/LeakedAccountRoles.sol";
import {AccountTestBase} from "./AccountTestBase.sol";

/// Dynamic opcode lint of the hot VERIFY path: records every opcode the proxy + implementation execute in
/// `verifyFrame()` (each branch: tank, self-pay, frozen) and fails on any opcode banned in validation (EIP-8141
/// public-mempool trace rules, ERC-8421 [OPCODES-*]), TLOAD/TSTORE, LOG*, and GAS not directly followed by a *CALL.
/// Needs `-vvv` (a tracer); `script/lint-verify.sh` runs it that way and fails if it was skipped.
contract VerifyOpcodesTest is AccountTestBase {
    function _pay(uint256 amount) internal view returns (bytes memory) {
        return _hotData(amount, _one(_usdcTransfer(alice, amount)));
    }

    // --------------------------------------------------------------------------- opcode conformance ------

    function _assertVerifyOpcodesClean() internal {
        simEnter(0);
        try vm.startDebugTraceRecording() {}
        catch {
            // Needs a tracer: `forge test -vvv` (CI, script/lint-verify.sh). Skipped otherwise.
            simLeave(0, STATUS_FAILED);
            vm.skip(true);
        }
        vm.prank(ENTRY_POINT);
        (bool ok,) = address(account).call(_verifyData());
        Vm.DebugStep[] memory steps = vm.stopAndReturnDebugTraceRecording();
        simLeave(0, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertTrue(ok, "verify failed");
        assertGt(steps.length, 100);
        uint64 base = type(uint64).max; // depth of the proxy's frame
        for (uint256 i; i < steps.length && base == type(uint64).max; ++i) {
            if (steps[i].contractAddr == address(account)) base = steps[i].depth;
        }
        uint256 checked;
        for (uint256 i; i < steps.length; ++i) {
            Vm.DebugStep memory s = steps[i];
            // Account code only: the proxy and the implementation (delegatecall). Deeper frames are the mocks that
            // stand in for one-opcode Yul helpers.
            if (s.depth > base + 1 || (s.contractAddr != address(account) && s.contractAddr != address(impl))) continue;
            ++checked;
            uint8 op = s.opcode;
            assertFalse(_banned(op), string.concat("banned opcode in VERIFY: ", vm.toString(op)));
            if (op == 0x5a) {
                uint8 next = steps[i + 1].opcode;
                assertTrue(next == 0xf1 || next == 0xf2 || next == 0xf4 || next == 0xfa, "GAS not before *CALL");
            }
        }
        assertGt(checked, 100);
    }

    function _banned(uint8 op) internal pure returns (bool) {
        return op == 0x31 || op == 0x3a || (op >= 0x40 && op <= 0x45) || op == 0x47 || op == 0x48 || op == 0x4a
            || op == 0x4b || op == 0x55 || op == 0x5c || op == 0x5d || (op >= 0xa0 && op <= 0xa4) || op == 0xf0
            || op == 0xf5 || op == 0xf6 || op == 0xfe || op == 0xff;
    }

    function test_opcodes_tankPath() public {
        _beginHotTx(_pay(5 * USD));
        _signHotTx();
        _assertVerifyOpcodesClean();
    }

    function test_opcodes_selfPayPath() public {
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetFeePolicy, (MAX_PRIO, true, tank)));
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(SELF_VERIFY, address(0), 80_000, _verifyData());
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simSignSecp256k1(0, hotPk);
        _assertVerifyOpcodesClean();
    }

    function test_opcodes_frozenPath() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        _beginHotTx(abi.encodeCall(LeakedAccountImpl.clearExpiredFreeze, ()));
        _signHotTx();
        _assertVerifyOpcodesClean();
    }
}

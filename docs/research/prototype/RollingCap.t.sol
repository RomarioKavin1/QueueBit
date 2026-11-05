// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RollingCap} from "../src/RollingCap.sol";

contract RollingCapTest is Test {
    RollingCap c;

    function setUp() public {
        c = new RollingCap(100e6); // $100 per day
    }

    function test_spendUpToCap() public {
        c.spend(60e6);
        c.spend(40e6);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 1, 0));
        c.spend(1);
    }

    /// The fixed-window flaw: spend at 23:59:54, again at 00:00:00. A rolling bucket only refills ~6s worth.
    function test_noMidnightDoubleSpend() public {
        vm.warp(1 days - 6);
        c.spend(100e6);
        vm.warp(1 days);
        vm.expectRevert();
        c.spend(1e6); // only ~$0.0069 refilled in 6s
    }

    function test_refillsLinearly() public {
        c.spend(100e6);
        vm.warp(block.timestamp + 12 hours);
        c.spend(50e6);
        vm.expectRevert();
        c.spend(1e6);
    }

    /// Worst case for a thief holding the hot key for D days: cap + D * cap, never more.
    function testFuzz_totalBoundedByTime(uint32 dt, uint8 n) public {
        uint256 spent;
        uint256 t0 = block.timestamp;
        for (uint256 i; i < n; i++) {
            vm.warp(block.timestamp + (uint256(dt) % 3 hours));
            uint256 a = c.available() + (block.timestamp - c.lastUpdate()) * 100e6 / 1 days;
            if (a > 100e6) a = 100e6;
            if (a == 0) continue;
            c.spend(a);
            spent += a;
        }
        assertLe(spent, 100e6 + (block.timestamp - t0) * 100e6 / 1 days);
    }
}

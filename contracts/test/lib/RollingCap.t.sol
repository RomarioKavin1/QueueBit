// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RollingCap} from "../../src/lib/RollingCap.sol";

/// Exposes the library over one storage bucket.
contract RollingCapHarness {
    using RollingCap for RollingCap.Bucket;

    RollingCap.Bucket internal bucket;

    constructor(uint256 cap_) {
        bucket.init(cap_);
    }

    function spend(uint256 usd) external {
        bucket.spend(usd);
    }

    function setCap(uint256 newCap) external {
        bucket.setCap(newCap);
    }

    function refill() external {
        bucket.refill();
    }

    function availableNow() external view returns (uint256) {
        return bucket.availableNow();
    }

    function cap() external view returns (uint256) {
        return bucket.cap;
    }

    function available() external view returns (uint256) {
        return bucket.available;
    }

    function lastUpdate() external view returns (uint256) {
        return bucket.lastUpdate;
    }
}

/// Port of `docs/research/prototype/RollingCap.t.sol`, plus the setCap and boundary cases of §10.3.4.
contract RollingCapTest is Test {
    uint256 internal constant CAP = 100e6; // $100 per day, 6 decimals

    /// The current block time. Under via-IR the optimizer may reuse one `_now()` read across `vm.warp`
    /// calls inside a test function, so tests read the time through the cheatcode instead.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    RollingCapHarness internal c;

    function setUp() public {
        vm.warp(1_700_000_000);
        c = new RollingCapHarness(CAP);
    }

    function test_startsFull() public view {
        assertEq(c.cap(), CAP);
        assertEq(c.available(), CAP);
        assertEq(c.lastUpdate(), _now());
    }

    function test_spendUpToCap() public {
        c.spend(60e6);
        c.spend(40e6);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 1, 0));
        c.spend(1);
    }

    function test_overCapReportsRequestedAndAvailable() public {
        c.spend(30e6);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 71e6, 70e6));
        c.spend(71e6);
    }

    function test_zeroSpendAlwaysSucceeds() public {
        c.spend(CAP);
        c.spend(0);
        assertEq(c.available(), 0);
    }

    /// The fixed-window flaw: spend at 23:59:54, again at 00:00:00. A rolling bucket only refills ~6 s worth.
    function test_noMidnightDoubleSpend() public {
        uint256 day = (_now() / 1 days + 1) * 1 days;
        vm.warp(day - 6);
        c.spend(CAP);
        vm.warp(day);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 1e6, (6 * CAP) / 1 days));
        c.spend(1e6);
    }

    function test_refillsLinearly() public {
        c.spend(CAP);
        vm.warp(_now() + 12 hours);
        c.spend(50e6);
        vm.expectRevert();
        c.spend(1e6);
    }

    function test_refillSaturatesAtCap() public {
        c.spend(10e6);
        vm.warp(_now() + 365 days);
        assertEq(c.availableNow(), CAP);
        c.refill();
        assertEq(c.available(), CAP);
        assertEq(c.lastUpdate(), _now());
    }

    function test_availableNowDoesNotWrite() public {
        c.spend(CAP);
        vm.warp(_now() + 6 hours);
        assertEq(c.availableNow(), CAP / 4);
        assertEq(c.available(), 0);
    }

    function test_setCapLowerClampsImmediately() public {
        c.spend(20e6); // 80 left
        c.setCap(50e6);
        assertEq(c.cap(), 50e6);
        assertEq(c.available(), 50e6);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 50e6 + 1, 50e6));
        c.spend(50e6 + 1);
    }

    function test_setCapRefillsAtTheOldRateFirst() public {
        c.spend(CAP);
        vm.warp(_now() + 12 hours); // 50 refilled at the old rate
        c.setCap(1000e6);
        assertEq(c.available(), 50e6);
        vm.warp(_now() + 12 hours); // +500 at the new rate
        assertEq(c.availableNow(), 550e6);
    }

    function test_setCapHigherDoesNotCreditTheDifference() public {
        c.setCap(1000e6);
        assertEq(c.available(), CAP);
    }

    function test_setCapZeroBlocksSpending() public {
        c.setCap(0);
        vm.warp(_now() + 7 days);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, 1, 0));
        c.spend(1);
    }

    /// Worst case for a thief holding the hot key: cap + elapsed * cap / 1 days, never more. (Prototype fuzz test.)
    function testFuzz_totalBoundedByTime(uint32 dt, uint8 n) public {
        uint256 spent;
        uint256 t0 = _now();
        for (uint256 i; i < n; i++) {
            vm.warp(_now() + (uint256(dt) % 3 hours));
            uint256 a = c.availableNow();
            if (a == 0) continue;
            c.spend(a);
            spent += a;
        }
        assertLe(spent, CAP + ((_now() - t0) * CAP) / 1 days);
    }

    /// Same bound with arbitrary caps, spend sizes and gaps, including cap changes that only tighten.
    function testFuzz_boundHoldsForAnyCapAndSchedule(uint64 cap, uint256 seed) public {
        cap = uint64(bound(cap, 1, type(uint64).max));
        RollingCapHarness h = new RollingCapHarness(cap);
        uint256 t0 = _now();
        uint256 spent;
        for (uint256 i; i < 32; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(_now() + (seed % 2 days));
            uint256 want = (seed >> 64) % (uint256(cap) + 1);
            if (want <= h.availableNow()) {
                h.spend(want);
                spent += want;
            } else {
                vm.expectRevert(abi.encodeWithSelector(RollingCap.OverCap.selector, want, h.availableNow()));
                h.spend(want);
            }
            assertLe(h.available(), h.cap());
        }
        assertLe(spent, uint256(cap) + ((_now() - t0) * uint256(cap)) / 1 days);
    }

    function testFuzz_availableNeverExceedsCap(uint64 cap, uint64 spend1, uint32 gap, uint64 newCap) public {
        RollingCapHarness h = new RollingCapHarness(cap);
        spend1 = uint64(bound(spend1, 0, cap));
        h.spend(spend1);
        vm.warp(_now() + gap);
        h.setCap(newCap);
        assertLe(h.available(), newCap);
        vm.warp(_now() + gap);
        assertLe(h.availableNow(), newCap);
    }
}

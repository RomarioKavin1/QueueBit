// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Hot-key spending bucket: one USD-denominated allowance that refills continuously (cap per 24h),
/// so there is no midnight reset to exploit. Values are in USD with 6 decimals.
contract RollingCap {
    uint256 public immutable cap;
    uint256 public available;
    uint256 public lastUpdate;

    error OverCap(uint256 requested, uint256 available);

    constructor(uint256 cap_) {
        cap = cap_;
        available = cap_;
        lastUpdate = block.timestamp;
    }

    function _refill() internal {
        uint256 refilled = available + (block.timestamp - lastUpdate) * cap / 1 days;
        available = refilled > cap ? cap : refilled;
        lastUpdate = block.timestamp;
    }

    function spend(uint256 usd) external {
        _refill();
        if (usd > available) revert OverCap(usd, available);
        available -= usd;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title RollingCap
/// @notice The hot key's spending bucket: one USD-denominated allowance (6 decimals) that refills continuously at
///         `cap` per 24 hours, so there is no fixed-window reset to exploit (the "spend at 23:59, again at 00:00"
///         double spend). Library form of `docs/research/prototype/RollingCap.sol`; spec in
///         `docs/plan/sections/10-contracts.md` §10.3.4.
/// @dev Invariant (I-1 in §10.7): over any interval of length `t` that starts with a full bucket, the total spent is
///      at most `cap + t * cap / 1 days`. Lowering the cap clamps `available` at once; raising it does not credit the
///      difference (the bucket refills toward the new cap at the new rate).
///      All functions read `block.timestamp`, so none of them may run in a VERIFY frame (TIMESTAMP is banned there,
///      §10.0.5); they belong to the execution side (`hotExecute`).
library RollingCap {
    struct Bucket {
        uint256 cap;
        uint256 available;
        uint48 lastUpdate;
    }

    /// @notice `requested` exceeds what the bucket holds after refilling.
    error OverCap(uint256 requested, uint256 available);

    /// @notice Starts a full bucket of `cap` now. For a bucket that is already in use, call `setCap`.
    function init(Bucket storage b, uint256 cap) internal {
        b.cap = cap;
        b.available = cap;
        b.lastUpdate = uint48(block.timestamp);
    }

    /// @notice What `refill` would leave in `available`, without writing.
    function availableNow(Bucket storage b) internal view returns (uint256) {
        return _refilled(b.cap, b.available, b.lastUpdate);
    }

    /// @notice available = min(cap, available + (now - lastUpdate) * cap / 1 days); lastUpdate = now.
    function refill(Bucket storage b) internal {
        b.available = _refilled(b.cap, b.available, b.lastUpdate);
        b.lastUpdate = uint48(block.timestamp);
    }

    /// @notice Refills, then debits `usd`, or reverts with `OverCap` when the bucket holds less.
    function spend(Bucket storage b, uint256 usd) internal {
        refill(b);
        uint256 avail = b.available;
        if (usd > avail) revert OverCap(usd, avail);
        unchecked {
            b.available = avail - usd;
        }
    }

    /// @notice Refills at the old rate, then sets the cap. Tightening takes effect immediately: `available` is
    ///         clamped to the new cap.
    function setCap(Bucket storage b, uint256 newCap) internal {
        refill(b);
        b.cap = newCap;
        if (b.available > newCap) b.available = newCap;
    }

    function _refilled(uint256 cap, uint256 available, uint48 lastUpdate) private view returns (uint256) {
        uint256 elapsed = block.timestamp - lastUpdate;
        // Once a full day has passed the bucket is full whatever it held; this also keeps `elapsed * cap` from
        // overflowing for any cap that fits a uint256 / 1 days.
        if (elapsed >= 1 days) return cap;
        uint256 refilled = available + (elapsed * cap) / 1 days;
        return refilled > cap ? cap : refilled;
    }
}

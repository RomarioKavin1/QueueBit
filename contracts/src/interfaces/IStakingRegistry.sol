// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IStakingRegistry
/// @notice The ERC-8421 staking registry ABI as deployed on the chain-1337 devnets (`NaiveStakingRegistry`; local
///         `0x8464135c8F25Da09e49BC8782676a84730C318bC`, public `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`).
///         Stake is keyed on `msg.sender`, so an entity has to call it itself (`docs/plan/50-devnet-review.md` F17).
interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    /// @return stake the staked amount, unstakeDelaySec the delay, withdrawTime 0 while locked.
    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime);
}

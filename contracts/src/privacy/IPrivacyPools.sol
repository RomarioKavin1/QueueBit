// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of the Privacy Pools v1 ABI (0xbow, `privacy-pools-core` @ df4bf73) that `PoolPayer` uses.
///         Written here from the deployed ABI so that `src/` does not depend on the vendored test copies; the struct
///         layouts are ABI-identical to `IPrivacyPool.Withdrawal` and `ProofLib.WithdrawProof`.
library PrivacyPoolsTypes {
    /// `IPrivacyPool.Withdrawal`. `context = keccak256(abi.encode(withdrawal, scope)) % SNARK_SCALAR_FIELD` binds it.
    struct Withdrawal {
        address processooor;
        bytes data;
    }

    /// `ProofLib.WithdrawProof`. pubSignals: [0] newCommitmentHash, [1] existingNullifierHash, [2] withdrawnValue,
    /// [3] stateRoot, [4] stateTreeDepth, [5] ASPRoot, [6] ASPTreeDepth, [7] context.
    struct WithdrawProof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[8] pubSignals;
    }
}

/// `IPrivacyPool` (+ `IState` getters).
interface IPrivacyPoolsPool {
    function withdraw(PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) external;
    function nullifierHashes(uint256 nullifierHash) external view returns (bool spent);
    function roots(uint256 index) external view returns (uint256 root);
    function ASSET() external view returns (address);
    function SCOPE() external view returns (uint256);
    function WITHDRAWAL_VERIFIER() external view returns (address);
    function dead() external view returns (bool);
}

/// `IEntrypoint`.
interface IPrivacyPoolsEntrypoint {
    function scopeToPool(uint256 scope) external view returns (address pool);
    function latestRoot() external view returns (uint256 root);
}

/// `IVerifier` (withdraw circuit, 8 public signals). Declared `view` so the call is a STATICCALL.
interface IPrivacyPoolsWithdrawalVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[8] calldata pubSignals
    ) external view returns (bool);
}

/// The ERC-8421 staking registry as deployed on the chain-1337 devnets (`NaiveStakingRegistry`; local
/// `0x8464135c8F25Da09e49BC8782676a84730C318bC`). Stake is keyed on `msg.sender`, so `PoolPayer` calls it itself.
interface IERC8421StakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime);
}

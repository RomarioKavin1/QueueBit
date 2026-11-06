// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IQueueBitAccountRoles} from "../../src/interfaces/IQueueBitAccountRoles.sol";

/// A stand-in for `QueueBitAccountImpl`'s role entry points (the real account is built separately): it authorises by
/// msg.sender like the account does, executes vault calls, records freezes. Also deployed on the devnet as the
/// mock target of the role-signer integration tests.
contract MockQueueBitAccount {
    address public vaultSigner;
    address public recoverySigner;
    address public guardian;
    bool public hotFrozen;
    uint256 public vaultCalls;
    bytes32 public lastCancelled;

    event VaultExecuted(address indexed by, uint256 calls, uint256 usdValue);
    event Frozen(address indexed by);
    event RecoveryCancelled(address indexed by, bytes32 opId);

    error NotVault();
    error NotRecovery();
    error NotGuardian();
    error AlreadySet();

    receive() external payable {}

    /// One-time wiring (the real account takes these in `initialize`).
    function setRoles(address vault, address recovery, address guardian_) external {
        if (vaultSigner != address(0)) revert AlreadySet();
        vaultSigner = vault;
        recoverySigner = recovery;
        guardian = guardian_;
    }

    /// Same shape as `IQueueBitAccountRoles.getRoles` (an unbound `PQRoleSigner` checks it).
    function getRoles() external view returns (address, address, address, uint48, uint32) {
        return (vaultSigner, recoverySigner, address(0), 0, 0);
    }

    function vaultExecute(IQueueBitAccountRoles.Call[] calldata calls, uint256 usdValue) external {
        if (msg.sender != vaultSigner) revert NotVault();
        for (uint256 i; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        vaultCalls++;
        emit VaultExecuted(msg.sender, calls.length, usdValue);
    }

    function recoveryCancel(bytes32 opId) external {
        if (msg.sender != recoverySigner) revert NotRecovery();
        lastCancelled = opId;
        emit RecoveryCancelled(msg.sender, opId);
    }

    function guardianFreeze() external {
        if (msg.sender != guardian) revert NotGuardian();
        hotFrozen = true;
        emit Frozen(msg.sender);
    }
}

/// The devnet's `NaiveStakingRegistry` logic (devnet/predeploy/src/NaiveStakingRegistry.sol, MIT), for unit tests.
contract MockStakingRegistry {
    struct Deposit {
        uint256 stake;
        uint32 unstakeDelaySec;
        uint64 withdrawTime;
    }

    mapping(address => Deposit) private deposits;

    function addStake(uint32 unstakeDelaySec) external payable {
        Deposit storage d = deposits[msg.sender];
        require(unstakeDelaySec >= d.unstakeDelaySec, "cannot decrease unstake delay");
        d.stake += msg.value;
        d.unstakeDelaySec = unstakeDelaySec;
        d.withdrawTime = 0;
    }

    function unlockStake() external {
        Deposit storage d = deposits[msg.sender];
        require(d.stake > 0, "no stake");
        require(d.withdrawTime == 0, "already unlocking");
        d.withdrawTime = uint64(block.timestamp) + d.unstakeDelaySec;
    }

    function withdrawStake(address payable withdrawAddress) external {
        Deposit storage d = deposits[msg.sender];
        require(d.withdrawTime != 0, "not unlocked");
        require(block.timestamp >= d.withdrawTime, "delay not elapsed");
        uint256 amount = d.stake;
        d.stake = 0;
        d.withdrawTime = 0;
        (bool success,) = withdrawAddress.call{value: amount}("");
        require(success, "withdraw failed");
    }

    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)
    {
        Deposit storage d = deposits[account];
        return (d.stake, d.unstakeDelaySec, d.withdrawTime);
    }
}

/// A contract that is neither the account nor the signer.
contract MockOther {
    uint256 public hits;

    receive() external payable {}

    function hit() external payable {
        hits++;
    }
}

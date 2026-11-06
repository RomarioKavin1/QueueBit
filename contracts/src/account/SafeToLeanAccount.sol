// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Upgrades a Safe (v1.3 / v1.4 proxy) into a LeanAccount at the same address. A Safe has no upgrade function: its
/// proxy forwards every call to the singleton address in storage slot 0. The owners sign one Safe transaction that
/// DELEGATECALLs `migrate`, which (running as the Safe) points slot 0 at the LeanAccount implementation and then calls
/// the account's own `initialize` as a self-call, installing the quantum-safe owner key. Funds, tokens and the address
/// stay; the Safe's code (and its owners' power) is gone. LeanAccount keeps its state in an ERC-7201 namespace, so it
/// doesn't collide with the Safe's old storage.
contract SafeToLeanAccount {
    error OnlyDelegateCall();
    error NotAContract();
    error InitializeFailed(bytes reason);

    address private immutable SELF = address(this);

    /// @param leanImplementation the LeanAccount implementation (a contract)
    /// @param initData `LeanAccount.initialize(...)` calldata: the keystore, its keys and policy, hook, executors
    function migrate(address leanImplementation, bytes calldata initData) external {
        if (address(this) == SELF) revert OnlyDelegateCall();
        if (leanImplementation.code.length == 0) revert NotAContract();
        assembly ("memory-safe") {
            sstore(0, leanImplementation)
        }
        (bool ok, bytes memory reason) = address(this).call(initData);
        if (!ok) revert InitializeFailed(reason);
    }
}

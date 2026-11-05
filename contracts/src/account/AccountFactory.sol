// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title AccountFactory
/// @notice Deterministic CREATE2 deployment of LEAKED account proxies (`ERC1967Proxy` -> `LeakedAccountImpl`), usable
///         as the target of an EIP-8141 deploy frame. Spec: `docs/plan/sections/10-contracts.md` §10.3.1.
/// @dev Stateless by design: a deploy frame "must not read mutable state outside tx.sender or maintain per-deploy
///      factory storage". The init data is part of the CREATE2 init code hash, so a front-runner who submits the
///      same call deploys the same account, and one who changes `initData` gets a different address: submitting
///      `createAccount` is safe for any party. Role-signer instances (`PQRoleSigner`) are deployed by their own
///      workstream's factory function; the account knows them only by address.
contract AccountFactory {
    event AccountCreated(address indexed account, address indexed implementation, bytes32 salt);

    error EmptyInitData();

    /// @notice Deploys (or returns, when already deployed) the proxy for `(salt, implementation, initData)`.
    /// @param initData `abi.encodeCall(LeakedAccountImpl.initialize, (cfg))`; must not be empty.
    function createAccount(bytes32 salt, address implementation, bytes calldata initData)
        external
        returns (address account)
    {
        if (initData.length == 0) revert EmptyInitData();
        account = predictAccount(salt, implementation, initData);
        if (account.code.length != 0) return account;
        account = address(new ERC1967Proxy{salt: salt}(implementation, initData));
        emit AccountCreated(account, implementation, salt);
    }

    function predictAccount(bytes32 salt, address implementation, bytes calldata initData)
        public
        view
        returns (address)
    {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, initData)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LeanAccount} from "./LeanAccount.sol";

/// Deploys LeanPool Accounts as EIP-1167 clones of one implementation, at CREATE2 addresses bound to the full initial
/// configuration (so an address commits to its first validator, keys, hook and executors).
contract LeanAccountFactory {
    address public immutable implementation;

    event AccountCreated(address indexed account, bytes32 salt);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    struct Init {
        address validator;
        bytes validatorInit;
        address hook;
        bytes hookInit;
        address[] executors;
        bytes[] executorInits;
    }

    function createAccount(bytes32 salt, Init calldata init) external payable returns (address account) {
        bytes32 s = _salt(salt, init);
        account = _predict(s);
        if (account.code.length == 0) {
            address impl = implementation;
            assembly ("memory-safe") {
                let p := mload(0x40)
                mstore(p, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
                mstore(add(p, 0x14), shl(0x60, impl))
                mstore(add(p, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
                account := create2(0, p, 0x37, s)
            }
            require(account != address(0), "clone failed");
            LeanAccount(payable(account)).initialize(
                init.validator, init.validatorInit, init.hook, init.hookInit, init.executors, init.executorInits
            );
            emit AccountCreated(account, salt);
        }
        if (msg.value > 0) {
            (bool ok,) = account.call{value: msg.value}("");
            require(ok, "funding failed");
        }
    }

    function predict(bytes32 salt, Init calldata init) external view returns (address) {
        return _predict(_salt(salt, init));
    }

    function _salt(bytes32 salt, Init calldata init) internal pure returns (bytes32) {
        return keccak256(abi.encode(salt, init));
    }

    function _predict(bytes32 s) internal view returns (address) {
        bytes32 codeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), s, codeHash)))));
    }
}

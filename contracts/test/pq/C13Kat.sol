// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// Reads KAT set C (`packages/pq-signer/vectors/c13.json`).
library C13Kat {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant PATH = "../packages/pq-signer/vectors/c13.json";
    uint256 internal constant COUNT = 32;

    struct Vector {
        bytes32 pk;
        bytes32 pkSeed;
        bytes32 pkRoot;
        bytes32 digest;
        bytes sig;
    }

    function json() internal view returns (string memory) {
        return vm.readFile(PATH);
    }

    function load(string memory j, uint256 i) internal pure returns (Vector memory v) {
        string memory p = string.concat(".vectors[", vm.toString(i), "]");
        v.pk = vm.parseJsonBytes32(j, string.concat(p, ".pk"));
        v.pkSeed = vm.parseJsonBytes32(j, string.concat(p, ".pkSeed"));
        v.pkRoot = vm.parseJsonBytes32(j, string.concat(p, ".pkRoot"));
        v.digest = vm.parseJsonBytes32(j, string.concat(p, ".digest"));
        v.sig = vm.parseJsonBytes(j, string.concat(p, ".sig"));
    }

    function load(uint256 i) internal view returns (Vector memory) {
        return load(json(), i);
    }
}

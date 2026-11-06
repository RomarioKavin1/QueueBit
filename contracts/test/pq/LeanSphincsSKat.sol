// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// Reads the leanSphincs-s KAT sets of the queuebit pq-signer package: set C (`vectors/leansphincs-s.json`, QueueBit derivation,
/// Light-tier keys, hedged signatures) and set A (`vectors/leansphincs-s-upstream.json`, upstream's fixture verbatim).
library LeanSphincsSKat {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant PATH = "../packages/pq-signer/vectors/leansphincs-s.json";
    string internal constant UPSTREAM_PATH = "../packages/pq-signer/vectors/leansphincs-s-upstream.json";
    uint256 internal constant COUNT = 32;
    uint256 internal constant UPSTREAM_COUNT = 6;

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

    function upstreamJson() internal view returns (string memory) {
        return vm.readFile(UPSTREAM_PATH);
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

    /// Upstream vectors carry only the high-aligned words; `pk = P ‖ root` is rebuilt from them.
    function loadUpstream(string memory j, uint256 i) internal pure returns (Vector memory v) {
        string memory p = string.concat(".vectors[", vm.toString(i), "]");
        v.pkSeed = vm.parseJsonBytes32(j, string.concat(p, ".pkSeed"));
        v.pkRoot = vm.parseJsonBytes32(j, string.concat(p, ".pkRoot"));
        v.pk = v.pkSeed | (v.pkRoot >> 128);
        v.digest = vm.parseJsonBytes32(j, string.concat(p, ".message"));
        v.sig = vm.parseJsonBytes(j, string.concat(p, ".sig"));
    }
}

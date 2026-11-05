// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Cross-check harness: runs the UNMODIFIED upstream leanSphincs-s verifier (copied into a temp Foundry project by
// scripts/onchain-crosscheck.sh) against the leanSphincs-s KAT sets A (upstream fixture) and C (LEAKED). Not part of
// the contracts workspace.
import "forge-std/Test.sol";
import "../src/LeanSphincs-SAsm.sol";

contract LeanSphincsSCrosscheck is Test {
    LeanSphincsSAsm verifier;

    function setUp() public {
        verifier = new LeanSphincsSAsm();
    }

    function testKatC_allVectorsVerify() public {
        string memory j = vm.readFile("vectors/leansphincs-s.json");
        assertEq(vm.parseJsonUint(j, ".sigLength"), 4164);
        uint256 minG = type(uint256).max;
        uint256 maxG;
        uint256 sumG;
        for (uint256 i = 0; i < 32; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            bytes32 s = vm.parseJsonBytes32(j, string.concat(p, ".pkSeed"));
            bytes32 r = vm.parseJsonBytes32(j, string.concat(p, ".pkRoot"));
            bytes32 m = vm.parseJsonBytes32(j, string.concat(p, ".digest"));
            bytes memory sig = vm.parseJsonBytes(j, string.concat(p, ".sig"));
            uint256 g0 = gasleft();
            bool ok = verifier.verify(s, r, m, sig);
            uint256 g = g0 - gasleft();
            assertTrue(ok, string.concat("vector rejected: ", vm.toString(i)));
            sig[2720] ^= 0x01;
            assertFalse(verifier.verify(s, r, m, sig));
            if (g < minG) minG = g;
            if (g > maxG) maxG = g;
            sumG += g;
        }
        emit log_named_uint("LeanSphincsSAsm verify gas (external call) min", minG);
        emit log_named_uint("LeanSphincsSAsm verify gas (external call) mean", sumG / 32);
        emit log_named_uint("LeanSphincsSAsm verify gas (external call) max", maxG);
    }

    function testKatA_upstreamVectorsVerify() public view {
        string memory j = vm.readFile("vectors/leansphincs-s-upstream.json");
        for (uint256 i = 0; i < 6; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            bytes32 s = vm.parseJsonBytes32(j, string.concat(p, ".pkSeed"));
            bytes32 r = vm.parseJsonBytes32(j, string.concat(p, ".pkRoot"));
            bytes32 m = vm.parseJsonBytes32(j, string.concat(p, ".message"));
            bytes memory sig = vm.parseJsonBytes(j, string.concat(p, ".sig"));
            assertTrue(verifier.verify(s, r, m, sig));
        }
    }

    function testKatC_everyByteFlipRejected() public view {
        string memory j = vm.readFile("vectors/leansphincs-s.json");
        bytes32 s = vm.parseJsonBytes32(j, ".vectors[0].pkSeed");
        bytes32 r = vm.parseJsonBytes32(j, ".vectors[0].pkRoot");
        bytes32 m = vm.parseJsonBytes32(j, ".vectors[0].digest");
        bytes memory sig = vm.parseJsonBytes(j, ".vectors[0].sig");
        for (uint256 i = 0; i < 4164; i++) {
            sig[i] ^= 0x80;
            assertFalse(verifier.verify(s, r, m, sig));
            sig[i] ^= 0x80;
        }
        assertTrue(verifier.verify(s, r, m, sig));
    }
}

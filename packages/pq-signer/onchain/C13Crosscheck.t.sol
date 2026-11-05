// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Cross-check harness: runs the UNMODIFIED upstream verifier (copied into a temp Foundry project by
// scripts/onchain-crosscheck.sh) against KAT sets A and C. Not part of the contracts workspace.
import "forge-std/Test.sol";
import "../src/SPHINCs-C13Asm.sol";

contract C13Crosscheck is Test {
    SphincsC13Asm verifier;

    function setUp() public {
        verifier = new SphincsC13Asm();
    }

    function _gas(bytes32 s, bytes32 r, bytes32 m, bytes memory sig) internal view returns (bool ok, uint256 g) {
        uint256 g0 = gasleft();
        ok = verifier.verify(s, r, m, sig);
        g = g0 - gasleft();
    }

    function testKatC_allVectorsVerify() public {
        string memory j = vm.readFile("vectors/c13.json");
        uint256 n = 32;
        assertEq(vm.parseJsonUint(j, ".sigLength"), 3688);
        uint256 minG = type(uint256).max;
        uint256 maxG;
        uint256 sumG;
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            bytes32 s = vm.parseJsonBytes32(j, string.concat(p, ".pkSeed"));
            bytes32 r = vm.parseJsonBytes32(j, string.concat(p, ".pkRoot"));
            bytes32 m = vm.parseJsonBytes32(j, string.concat(p, ".digest"));
            bytes memory sig = vm.parseJsonBytes(j, string.concat(p, ".sig"));
            assertEq(sig.length, 3688);
            (bool ok, uint256 g) = _gas(s, r, m, sig);
            assertTrue(ok, string.concat("vector rejected: ", vm.toString(i)));
            if (g < minG) minG = g;
            if (g > maxG) maxG = g;
            sumG += g;
        }
        emit log_named_uint("C13 verify gas (external call) min", minG);
        emit log_named_uint("C13 verify gas (external call) mean", sumG / n);
        emit log_named_uint("C13 verify gas (external call) max", maxG);
    }

    function testKatA_upstreamVectorsVerify() public view {
        string memory j = vm.readFile("vectors/upstream_c13.json");
        for (uint256 i = 0; i < 5; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            bytes32 s = bytes32(vm.parseJsonBytes(j, string.concat(p, ".pkSeed")));
            bytes32 r = bytes32(vm.parseJsonBytes(j, string.concat(p, ".pkRoot")));
            bytes32 m = vm.parseJsonBytes32(j, string.concat(p, ".msg"));
            bytes memory sig = vm.parseJsonBytes(j, string.concat(p, ".sig"));
            assertTrue(verifier.verify(s, r, m, sig));
        }
    }

    function testKatC_negativeRecipes() public {
        string memory j = vm.readFile("vectors/c13.json");
        bytes32 s = vm.parseJsonBytes32(j, ".vectors[0].pkSeed");
        bytes32 r = vm.parseJsonBytes32(j, ".vectors[0].pkRoot");
        bytes32 m = vm.parseJsonBytes32(j, ".vectors[0].digest");
        bytes memory sig = vm.parseJsonBytes(j, ".vectors[0].sig");
        uint256[12] memory offs = [uint256(0), 15, 16, 127, 128, 1951, 1952, 2639, 2640, 2643, 2644, 3687];
        for (uint256 k = 0; k < offs.length; k++) {
            sig[offs[k]] ^= 0x01;
            assertFalse(verifier.verify(s, r, m, sig));
            sig[offs[k]] ^= 0x01;
        }
        // every byte, one bit (the whole 3688-byte string is consumed)
        for (uint256 i = 0; i < 3688; i += 1) {
            sig[i] ^= 0x80;
            assertFalse(verifier.verify(s, r, m, sig));
            sig[i] ^= 0x80;
        }
        assertFalse(verifier.verify(s, r, m ^ bytes32(uint256(1)), sig));
        assertFalse(verifier.verify(r, s, m, sig)); // swapped halves
        bytes32 s2 = vm.parseJsonBytes32(j, ".vectors[5].pkSeed");
        bytes32 r2 = vm.parseJsonBytes32(j, ".vectors[5].pkRoot");
        assertFalse(verifier.verify(s2, r2, m, sig));
        assertFalse(verifier.verify(s, r, m, new bytes(3688)));
        // counter + 1 on both layers
        for (uint256 off = 2643; off <= 3511; off += 868) {
            sig[off] = bytes1(uint8(sig[off]) + 1);
            assertFalse(verifier.verify(s, r, m, sig));
            sig[off] = bytes1(uint8(sig[off]) - 1);
        }
        assertTrue(verifier.verify(s, r, m, sig));
        // wrong length reverts in the raw verifier (the adapter must map it to false)
        bytes memory short_ = new bytes(3687);
        vm.expectRevert(bytes("Invalid sig length"));
        verifier.verify(s, r, m, short_);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {IPQVerifier} from "../../src/interfaces/IPQVerifier.sol";
import {C13Kat} from "./C13Kat.sol";

/// KAT set C through the IPQVerifier adapter: every positive vector verifies, every negative recipe of the vectors
/// file returns false without reverting, malformed lengths return false (the raw upstream verifier reverts there).
contract C13VerifierTest is Test {
    C13Verifier internal v;
    string internal j;

    function setUp() public {
        v = new C13Verifier();
        j = C13Kat.json();
    }

    // ------------------------------------------------------------------------------------------- metadata ------

    function test_metadata_matchesVectorsFile() public view {
        assertEq(v.schemeId(), vm.parseJsonBytes32(j, ".schemeId"), "schemeId == @leaked/pq-signer SCHEME_ID");
        assertEq(v.schemeId(), keccak256(bytes(vm.parseJsonString(j, ".schemeIdPreimage"))));
        assertEq(v.schemeId(), keccak256("SPHINCS-C13/keccak/fips-adrs/v1"));
        assertEq(v.sigLength(), vm.parseJsonUint(j, ".sigLength"));
        assertEq(v.sigLength(), 3688);
        assertGt(v.verifyGasEstimate(), 100_000);
    }

    // ------------------------------------------------------------------------------------------- positive ------

    function test_kat_allVectorsVerify() public {
        uint256 minG = type(uint256).max;
        uint256 maxG;
        uint256 sumG;
        for (uint256 i; i < C13Kat.COUNT; i++) {
            C13Kat.Vector memory k = C13Kat.load(j, i);
            // the pk convention: pkSeed ‖ pkRoot, each half top-aligned in the upstream words
            assertEq(k.pkSeed, k.pk & bytes32(type(uint256).max << 128));
            assertEq(k.pkRoot, k.pk << 128);
            uint256 g0 = gasleft();
            bool ok = v.verify(k.pk, k.digest, k.sig);
            uint256 g = g0 - gasleft();
            assertTrue(ok, string.concat("vector rejected: ", vm.toString(i)));
            // the inherited upstream ABI agrees
            assertTrue(v.verify(k.pkSeed, k.pkRoot, k.digest, k.sig));
            if (g < minG) minG = g;
            if (g > maxG) maxG = g;
            sumG += g;
        }
        emit log_named_uint("C13Verifier.verify gas (external call) min", minG);
        emit log_named_uint("C13Verifier.verify gas (external call) mean", sumG / C13Kat.COUNT);
        emit log_named_uint("C13Verifier.verify gas (external call) max", maxG);
        assertLe(maxG, v.verifyGasEstimate(), "verifyGasEstimate covers the measured max");
    }

    // ---------------------------------------------------------------------------- negative recipes (file) ------

    /// The recipes listed under `.negative` in c13.json, applied to every positive vector.
    function test_kat_negativeRecipes_everyVector() public view {
        uint256[12] memory offs = [uint256(0), 15, 16, 127, 128, 1951, 1952, 2639, 2640, 2643, 2644, 3687];
        for (uint256 i; i < C13Kat.COUNT; i++) {
            C13Kat.Vector memory k = C13Kat.load(j, i);
            // flipBit (sampled offsets; exhaustive for one vector below)
            for (uint256 o; o < offs.length; o++) {
                k.sig[offs[o]] ^= 0x01;
                assertFalse(v.verify(k.pk, k.digest, k.sig), "flipBit");
                k.sig[offs[o]] ^= 0x01;
            }
            // flipDigestBit at byte 0 and 31
            assertFalse(v.verify(k.pk, k.digest ^ bytes32(uint256(1) << 255), k.sig), "flipDigestBit 0");
            assertFalse(v.verify(k.pk, k.digest ^ bytes32(uint256(1)), k.sig), "flipDigestBit 31");
            // truncate / extend / empty: false, no revert (raw verifier reverts)
            assertFalse(v.verify(k.pk, k.digest, _resize(k.sig, 3687)), "truncate");
            assertFalse(v.verify(k.pk, k.digest, _resize(k.sig, 3689)), "extend");
            assertFalse(v.verify(k.pk, k.digest, ""), "empty");
            // allZero / allFF
            assertFalse(v.verify(k.pk, k.digest, new bytes(3688)), "allZero");
            assertFalse(v.verify(k.pk, k.digest, _filled(3688, 0xff)), "allFF");
            // swapPkHalves
            assertFalse(v.verify((k.pk << 128) | (k.pk >> 128), k.digest, k.sig), "swapPkHalves");
            // otherVectorPk: vectors 0-3 are one key (vault), 4-5 another (recovery); take a different key
            bytes32 other = C13Kat.load(j, i < 4 ? 4 : 0).pk;
            assertTrue(other != k.pk);
            assertFalse(v.verify(other, k.digest, k.sig), "otherVectorPk");
            // wotsCountPlusOne: big-endian uint32 counter at 2640 (layer 0) and 3508 (layer 1)
            assertFalse(v.verify(k.pk, k.digest, _counterPlusOne(k.sig, 2640)), "wotsCountPlusOne L0");
            assertFalse(v.verify(k.pk, k.digest, _counterPlusOne(k.sig, 3508)), "wotsCountPlusOne L1");
            // and the untouched vector still verifies
            assertTrue(v.verify(k.pk, k.digest, k.sig));
        }
    }

    /// flipBit, exhaustive: one bit of every one of the 3,688 bytes of vector 1 (all bytes are consumed).
    function test_kat_flipBit_everyByte() public view {
        C13Kat.Vector memory k = C13Kat.load(j, 1);
        for (uint256 i; i < 3688; i++) {
            k.sig[i] ^= 0x80;
            assertFalse(v.verify(k.pk, k.digest, k.sig));
            k.sig[i] ^= 0x80;
        }
    }

    /// The raw upstream entry point reverts where the adapter returns false (why the adapter exists).
    function test_rawUpstreamReverts_adapterDoesNot() public {
        C13Kat.Vector memory k = C13Kat.load(j, 1);
        vm.expectRevert(bytes("Invalid sig length"));
        v.verify(k.pkSeed, k.pkRoot, k.digest, _resize(k.sig, 3687));
        // non-canonical key: unreachable through the adapter (the split always yields top-aligned words)
        vm.expectRevert(bytes("Invalid public key"));
        v.verify(k.pkSeed | bytes32(uint256(1)), k.pkRoot, k.digest, k.sig);
        assertFalse(v.verify(k.pk, k.digest, _resize(k.sig, 3687)));
    }

    /// Out of gas inside the self-call maps to false (with 1/64 left to return it), never a revert.
    function test_lowGas_returnsFalse() public view {
        C13Kat.Vector memory k = C13Kat.load(j, 1);
        (bool ok, bytes memory ret) =
            address(v).staticcall{gas: 60_000}(abi.encodeCall(IPQVerifier.verify, (k.pk, k.digest, k.sig)));
        assertTrue(ok, "no revert");
        assertFalse(abi.decode(ret, (bool)));
    }

    // ------------------------------------------------------------------------------------------------ fuzz ------

    function testFuzz_wrongLength_returnsFalse(bytes32 pk, bytes32 digest, uint16 len, uint8 fill) public view {
        vm.assume(len != 3688);
        len = uint16(bound(len, 0, 8000));
        vm.assume(len != 3688);
        assertFalse(v.verify(pk, digest, _filled(len, fill)));
    }

    function testFuzz_randomSignature_returnsFalse(bytes32 pk, bytes32 digest, uint256 seed) public view {
        bytes memory sig = new bytes(3688);
        for (uint256 w; w < 3688; w += 32) {
            bytes32 word = keccak256(abi.encode(seed, w));
            assembly ("memory-safe") {
                mstore(add(add(sig, 32), w), word)
            }
        }
        // the last word ends inside the allocation (3,688 rounds up to 3,712 bytes)
        assertFalse(v.verify(pk, digest, sig));
    }

    function testFuzz_flipAnyBit_rejected(uint8 vec, uint16 byteIndex, uint8 bit) public view {
        C13Kat.Vector memory k = C13Kat.load(j, bound(vec, 0, C13Kat.COUNT - 1));
        uint256 i = bound(byteIndex, 0, 3687);
        k.sig[i] ^= bytes1(uint8(1) << (bit % 8));
        assertFalse(v.verify(k.pk, k.digest, k.sig));
    }

    function testFuzz_otherDigest_rejected(uint8 vec, bytes32 digest) public view {
        C13Kat.Vector memory k = C13Kat.load(j, bound(vec, 0, C13Kat.COUNT - 1));
        vm.assume(digest != k.digest);
        assertFalse(v.verify(k.pk, digest, k.sig));
    }

    function testFuzz_otherPk_rejected(uint8 vec, bytes32 pk) public view {
        C13Kat.Vector memory k = C13Kat.load(j, bound(vec, 0, C13Kat.COUNT - 1));
        vm.assume(pk != k.pk);
        assertFalse(v.verify(pk, k.digest, k.sig));
    }

    // --------------------------------------------------------------------------------------------- helpers ------

    function _resize(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n && i < b.length; i++) {
            out[i] = b[i];
        }
    }

    function _filled(uint256 n, uint8 x) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; i++) {
            out[i] = bytes1(x);
        }
    }

    function _counterPlusOne(bytes memory sig, uint256 off) internal pure returns (bytes memory out) {
        out = _resize(sig, sig.length);
        uint32 c = uint32(bytes4(abi.encodePacked(out[off], out[off + 1], out[off + 2], out[off + 3])));
        unchecked {
            c += 1;
        }
        bytes4 nb = bytes4(c);
        for (uint256 b; b < 4; b++) {
            out[off + b] = nb[b];
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LeanSphincsSVerifier} from "../../src/pq/LeanSphincsSVerifier.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {IPQVerifier} from "../../src/interfaces/IPQVerifier.sol";
import {LeanSphincsSKat} from "./LeanSphincsSKat.sol";
import {C13Kat} from "./C13Kat.sol";

/// leanSphincs-s through the IPQVerifier adapter: KAT set A (upstream fixture) and set C (QueueBit) verify, every negative
/// recipe of the vectors file returns false without reverting, malformed lengths return false (the raw upstream
/// verifier reverts there), and C13 material is rejected.
contract LeanSphincsSVerifierTest is Test {
    LeanSphincsSVerifier internal v;
    string internal j;

    uint256 internal constant LEN = 4164;

    function setUp() public {
        v = new LeanSphincsSVerifier();
        j = LeanSphincsSKat.json();
    }

    // ------------------------------------------------------------------------------------------- metadata ------

    function test_metadata_matchesVectorsFile() public view {
        assertEq(v.schemeId(), vm.parseJsonBytes32(j, ".schemeId"), "schemeId == schemes.leanSphincsS.SCHEME_ID");
        assertEq(v.schemeId(), keccak256(bytes(vm.parseJsonString(j, ".schemeIdPreimage"))));
        assertEq(v.schemeId(), keccak256("leanSphincs-s/keccak/v1"));
        assertTrue(v.schemeId() != keccak256("SPHINCS-C13/keccak/fips-adrs/v1"), "distinct from C13");
        assertEq(v.sigLength(), vm.parseJsonUint(j, ".sigLength"));
        assertEq(v.sigLength(), LEN);
        assertTrue(vm.parseJsonBool(j, ".experimental"));
        assertLt(v.verifyGasEstimate(), 100_000);
    }

    // ------------------------------------------------------------------------------------------- positive ------

    function test_katC_allVectorsVerify() public {
        uint256 minG = type(uint256).max;
        uint256 maxG;
        uint256 sumG;
        string memory jm = j;
        for (uint256 i; i < LeanSphincsSKat.COUNT; i++) {
            LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(jm, i);
            assertEq(k.pkSeed, k.pk & bytes32(type(uint256).max << 128));
            assertEq(k.pkRoot, k.pk << 128);
            uint256 g0 = gasleft();
            bool ok = v.verify(k.pk, k.digest, k.sig);
            uint256 g = g0 - gasleft();
            assertTrue(ok, string.concat("vector rejected: ", vm.toString(i)));
            assertTrue(v.verify(k.pkSeed, k.pkRoot, k.digest, k.sig), "inherited upstream ABI agrees");
            if (g < minG) minG = g;
            if (g > maxG) maxG = g;
            sumG += g;
        }
        emit log_named_uint("LeanSphincsSVerifier.verify gas (external call) min", minG);
        emit log_named_uint("LeanSphincsSVerifier.verify gas (external call) mean", sumG / LeanSphincsSKat.COUNT);
        emit log_named_uint("LeanSphincsSVerifier.verify gas (external call) max", maxG);
        assertLe(maxG, v.verifyGasEstimate(), "verifyGasEstimate covers the measured max");
    }

    /// KAT set A: upstream's own fixture (b = 6, 10, 12; made by upstream lssk, confirmed by its Python verifier).
    function test_katA_upstreamFixtureVerifies() public view {
        string memory u = LeanSphincsSKat.upstreamJson();
        assertEq(vm.parseJsonUint(u, ".sig_len"), LEN);
        for (uint256 i; i < LeanSphincsSKat.UPSTREAM_COUNT; i++) {
            LeanSphincsSKat.Vector memory k = LeanSphincsSKat.loadUpstream(u, i);
            assertTrue(v.verify(k.pk, k.digest, k.sig), string.concat("upstream vector rejected: ", vm.toString(i)));
            assertTrue(v.verify(k.pkSeed, k.pkRoot, k.digest, k.sig));
            k.sig[2720] ^= 0x01;
            assertFalse(v.verify(k.pk, k.digest, k.sig));
        }
    }

    // ---------------------------------------------------------------------------- negative recipes (file) ------

    /// The recipes listed under `.negative` in leansphincs-s.json, applied to every positive vector.
    function test_katC_negativeRecipes_everyVector() public view {
        uint256[12] memory offs = [uint256(0), 15, 16, 31, 32, 2719, 2720, 2723, 2724, 3747, 3748, 4163];
        string memory jm = j; // one copy of the 300 KB file in memory (not one per load)
        bytes32 pkVault0 = LeanSphincsSKat.load(jm, 0).pk;
        bytes32 pkRecovery0 = LeanSphincsSKat.load(jm, 4).pk;
        for (uint256 i; i < LeanSphincsSKat.COUNT; i++) {
            LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(jm, i);
            for (uint256 o; o < offs.length; o++) {
                k.sig[offs[o]] ^= 0x01;
                assertFalse(v.verify(k.pk, k.digest, k.sig), "flipBit");
                k.sig[offs[o]] ^= 0x01;
            }
            assertFalse(v.verify(k.pk, k.digest ^ bytes32(uint256(1) << 255), k.sig), "flipDigestBit 0");
            assertFalse(v.verify(k.pk, k.digest ^ bytes32(uint256(1)), k.sig), "flipDigestBit 31");
            assertFalse(v.verify(k.pk, k.digest, _resize(k.sig, LEN - 1)), "truncate");
            assertFalse(v.verify(k.pk, k.digest, _resize(k.sig, LEN + 1)), "extend");
            assertFalse(v.verify(k.pk, k.digest, ""), "empty");
            assertFalse(v.verify(k.pk, k.digest, _resize(k.sig, 3688)), "c13Length");
            assertFalse(v.verify(k.pk, k.digest, new bytes(LEN)), "allZero");
            assertFalse(v.verify(k.pk, k.digest, _filled(LEN, 0xff)), "allFF");
            assertFalse(v.verify((k.pk << 128) | (k.pk >> 128), k.digest, k.sig), "swapPkHalves");
            bytes32 other = i < 4 ? pkRecovery0 : pkVault0;
            assertTrue(other != k.pk);
            assertFalse(v.verify(other, k.digest, k.sig), "otherVectorPk");
            assertFalse(v.verify(k.pk, k.digest, _counterPlusOne(k.sig)), "counterPlusOne");
            assertTrue(v.verify(k.pk, k.digest, k.sig));
        }
    }

    /// flipBit, exhaustive: one bit of every one of the 4,164 bytes of vector 1 (all bytes are consumed).
    function test_katC_flipBit_everyByte() public view {
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(j, 1);
        for (uint256 i; i < LEN; i++) {
            k.sig[i] ^= 0x80;
            assertFalse(v.verify(k.pk, k.digest, k.sig));
            k.sig[i] ^= 0x80;
        }
    }

    /// C13 keys and signatures are not leanSphincs-s ones (and the other way round).
    function test_crossScheme_rejected() public {
        C13Kat.Vector memory c = C13Kat.load(1);
        assertFalse(v.verify(c.pk, c.digest, c.sig), "C13 signature (3,688 B)");
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(j, 1);
        C13Verifier c13 = new C13Verifier();
        assertFalse(c13.verify(k.pk, k.digest, k.sig), "leanSphincs-s signature through C13");
        assertFalse(v.verify(c.pk, k.digest, k.sig), "C13 key");
    }

    /// The raw upstream entry point reverts where the adapter returns false (why the adapter exists).
    function test_rawUpstreamReverts_adapterDoesNot() public {
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(j, 1);
        vm.expectRevert(bytes("Invalid sig length"));
        v.verify(k.pkSeed, k.pkRoot, k.digest, _resize(k.sig, LEN - 1));
        vm.expectRevert(bytes("Invalid public key"));
        v.verify(k.pkSeed | bytes32(uint256(1)), k.pkRoot, k.digest, k.sig);
        vm.expectRevert(bytes("Invalid public key"));
        v.verify(k.pkSeed, k.pkRoot | bytes32(uint256(1)), k.digest, k.sig);
        assertFalse(v.verify(k.pk, k.digest, _resize(k.sig, LEN - 1)));
    }

    /// Out of gas inside the self-call maps to false (with 1/64 left to return it), never a revert.
    function test_lowGas_returnsFalse() public view {
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(j, 1);
        (bool ok, bytes memory ret) =
            address(v).staticcall{gas: 25_000}(abi.encodeCall(IPQVerifier.verify, (k.pk, k.digest, k.sig)));
        assertTrue(ok, "no revert");
        assertFalse(abi.decode(ret, (bool)));
    }

    // ------------------------------------------------------------------------------------------------ fuzz ------

    function testFuzz_wrongLength_returnsFalse(bytes32 pk, bytes32 digest, uint16 len, uint8 fill) public view {
        len = uint16(bound(len, 0, 9000));
        vm.assume(len != LEN);
        assertFalse(v.verify(pk, digest, _filled(len, fill)));
    }

    function testFuzz_randomSignature_returnsFalse(bytes32 pk, bytes32 digest, uint256 seed) public view {
        bytes memory sig = new bytes(LEN);
        for (uint256 w; w < LEN; w += 32) {
            bytes32 word = keccak256(abi.encode(seed, w));
            assembly ("memory-safe") {
                mstore(add(add(sig, 32), w), word)
            }
        }
        // the last word ends inside the allocation (4,164 rounds up to 4,192 bytes)
        assertFalse(v.verify(pk, digest, sig));
    }

    function testFuzz_flipAnyBit_rejected(uint8 vec, uint16 byteIndex, uint8 bit) public view {
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(j, bound(vec, 0, LeanSphincsSKat.COUNT - 1));
        uint256 i = bound(byteIndex, 0, LEN - 1);
        k.sig[i] ^= bytes1(uint8(1) << (bit % 8));
        assertFalse(v.verify(k.pk, k.digest, k.sig));
    }

    function testFuzz_otherDigest_rejected(uint8 vec, bytes32 digest) public view {
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(j, bound(vec, 0, LeanSphincsSKat.COUNT - 1));
        vm.assume(digest != k.digest);
        assertFalse(v.verify(k.pk, digest, k.sig));
    }

    function testFuzz_otherPk_rejected(uint8 vec, bytes32 pk) public view {
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(j, bound(vec, 0, LeanSphincsSKat.COUNT - 1));
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

    /// The WOTS+C counter is a little-endian uint32 at 2720.
    function _counterPlusOne(bytes memory sig) internal pure returns (bytes memory out) {
        out = _resize(sig, sig.length);
        uint32 c = uint32(uint8(out[2720])) | (uint32(uint8(out[2721])) << 8) | (uint32(uint8(out[2722])) << 16)
            | (uint32(uint8(out[2723])) << 24);
        unchecked {
            c += 1;
        }
        for (uint256 b; b < 4; b++) {
            out[2720 + b] = bytes1(uint8(c >> (8 * b)));
        }
    }
}

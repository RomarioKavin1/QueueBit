// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";

/// Isolated verifier gas (the Forge cross-check of the devnet numbers). For every scheme with a vector file in
/// bench/vectors (written by `node dist/cli.js vectors`), deploy the vendored verifier, call it with exactly the
/// calldata BenchAccount builds (selector ‖ static words ‖ digest ‖ offset ‖ length ‖ witness, zero-padded), and
/// log the gas of the external STATICCALL measured with gasleft(): cold account access + calldata copy + verify.
/// Also checks that every vector is accepted and that a one-bit change is rejected (false or revert).
/// Lines starting with BENCHGAS are parsed by the harness.
contract VerifyGasTest is Test {
    string[] internal ids;

    function setUp() public {
        ids.push("sphincs-c13");
        ids.push("sphincs-c7");
        ids.push("leansphincs-s");
        ids.push("slh-dsa-sha2-128-24");
        ids.push("slh-dsa-sha2-128s");
        ids.push("porst-r16");
        ids.push("porst-r256");
        ids.push("ethfalcon");
    }

    function _calldata(bytes4 sel, bytes32[] memory statics, bytes32 digest, bytes memory sig)
        internal
        pure
        returns (bytes memory data)
    {
        data = abi.encodePacked(sel);
        for (uint256 i = 0; i < statics.length; i++) {
            data = abi.encodePacked(data, statics[i]);
        }
        uint256 padded = (sig.length + 31) / 32 * 32;
        data = abi.encodePacked(
            data, digest, uint256(32 * (statics.length + 2)), sig.length, sig, new bytes(padded - sig.length)
        );
    }

    function _accepted(address v, bytes memory data, bytes32 okWord) internal view returns (bool, uint256) {
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = v.staticcall(data);
        uint256 used = g0 - gasleft();
        return (ok && ret.length >= 32 && bytes32(ret) == okWord, used);
    }

    function test_verifyGas() public {
        uint256 seen;
        for (uint256 s = 0; s < ids.length; s++) {
            string memory path = string.concat(vm.projectRoot(), "/../vectors/", ids[s], ".json");
            if (!vm.exists(path)) {
                console.log("BENCHSKIP", ids[s]);
                continue;
            }
            seen++;
            string memory j = vm.readFile(path);
            string memory artifact = vm.parseJsonString(j, ".artifact");
            bytes memory ctorArgs = vm.parseJsonBytes(j, ".ctorArgs");
            bytes4 sel = bytes4(vm.parseJsonBytes(j, ".selector"));
            bytes32 okWord = vm.parseJsonBytes32(j, ".okWord");
            bytes32[] memory statics = vm.parseJsonBytes32Array(j, ".staticArgs");
            bytes32[] memory digests = vm.parseJsonBytes32Array(j, ".digests");
            bytes[] memory sigs = vm.parseJsonBytesArray(j, ".sigs");
            assertEq(digests.length, sigs.length, "digests/sigs");

            address v = deployCode(artifact, ctorArgs);
            for (uint256 i = 0; i < sigs.length; i++) {
                // fresh account access per sample: measure the cold call every time
                vm.cool(v);
                (bool good, uint256 used) = _accepted(v, _calldata(sel, statics, digests[i], sigs[i]), okWord);
                assertTrue(good, string.concat(ids[s], ": vector rejected"));
                console.log("BENCHGAS", ids[s], sigs[i].length, used);
            }
            // tamper: flip one bit in the middle of the first witness
            bytes memory bad = sigs[0];
            bad[bad.length / 2] = bad[bad.length / 2] ^ 0x01;
            (bool accepted,) = _accepted(v, _calldata(sel, statics, digests[0], bad), okWord);
            assertFalse(accepted, string.concat(ids[s], ": tampered witness accepted"));
            // wrong digest
            (accepted,) = _accepted(v, _calldata(sel, statics, ~digests[0], sigs[0]), okWord);
            assertFalse(accepted, string.concat(ids[s], ": wrong digest accepted"));
        }
        assertGt(seen, 0, "no vectors found: run the vectors step");
    }
}

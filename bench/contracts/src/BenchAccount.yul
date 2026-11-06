// SPDX-License-Identifier: MIT
//
// BenchAccount: a minimal EIP-8141 sender used by the QueueBit PQ-in-VERIFY benchmark (bench/). Written for this
// repo. One deployment per (scheme, key). NOT a wallet: no replay protection beyond the protocol nonce, no
// upgrade path, and the Path B ECDSA "payer" key is trusted only to authorize gas. Do not hold real funds.
//
// It calls an unmodified upstream verifier directly (no adapter hop where the upstream ABI allows it), so the
// VERIFY-frame gas it reports is "verifier + the cheapest possible frame glue": SIGPARAM checks, one SIGDATACOPY
// into the ABI buffer, one STATICCALL, APPROVE.
//
// Why Yul: TXPARAM (0xb0), FRAMEPARAM (0xb3), SIGPARAM (0xb4), SIGDATACOPY (0xb5) and APPROVE (0xaa) are only
// reachable through `verbatim_*`, which Solidity inline assembly does not offer. Opcode bytes are the chain-1337
// (ERC-8421 workshop devnet) / EIP-8141 draft assignments (docs/plan/50-devnet-review.md F4-F8).
//
// Deployment: creation code ‖ config (8 words, see below). Config is stored as immutables (PUSH32 in the runtime,
// no SLOAD in VERIFY).
//   w0 verifier address          w4 static arg 1
//   w1 selector (top 4 bytes)    w5 expected first return word (1 = bool true; ERC-1271 magic for PORST)
//   w2 static arg count (0..2)   w6 required witness length (0 = any)
//   w3 static arg 0              w7 Path B payer EOA (SECP256K1 resolved signer of signature entry 1)
//
// Verifier calldata built in memory: selector ‖ static args ‖ TXPARAM(SIG_HASH) ‖ bytes-offset ‖ len ‖ witness,
// i.e. f(bytes32...,bytes32 digest, bytes sig). The witness always lands at 0xa4 (upstream SphincsFrameVerify
// convention); the header is shifted down for fewer static args.
//
// Frame data (first byte = op):
//   0x01                    VERIFY, Path A: PQ-verify ARBITRARY entry 0 over the sig hash, then APPROVE(scope).
//   0x02                    VERIFY, Path B: entry 1 must be SECP256K1 by `payer` over the sig hash; APPROVE(scope).
//                           (The protocol has already checked the ECDSA signature before any frame runs.)
//   0x03 ‖ recipient(20)    SENDER: send 1 wei to recipient.
//   0x04 ‖ recipient(20)    SENDER, Path B: PQ-verify entry 0 (revert if invalid), then send 1 wei.
//   0x05 ‖ target(20) ‖ value(32) ‖ data
//                           SENDER: call target with value and data (used once to stake the account on the
//                           NaiveStakingRegistry, so the BUDGET-010 sidecar grants it the staked budget).
//   (empty)                 accept ETH.
object "BenchAccount" {
    code {
        let cfg := sub(codesize(), 0x100)
        codecopy(0x00, cfg, 0x100)
        let w0 := mload(0x00)
        let w1 := mload(0x20)
        let w2 := mload(0x40)
        let w3 := mload(0x60)
        let w4 := mload(0x80)
        let w5 := mload(0xa0)
        let w6 := mload(0xc0)
        let w7 := mload(0xe0)
        if gt(w2, 2) { revert(0, 0) }
        datacopy(0x00, dataoffset("runtime"), datasize("runtime"))
        setimmutable(0x00, "verifier", w0)
        setimmutable(0x00, "selector", w1)
        setimmutable(0x00, "nStatic", w2)
        setimmutable(0x00, "s0", w3)
        setimmutable(0x00, "s1", w4)
        setimmutable(0x00, "okWord", w5)
        setimmutable(0x00, "sigLen", w6)
        setimmutable(0x00, "payer", w7)
        return(0x00, datasize("runtime"))
    }

    object "runtime" {
        code {
            // Each verbatim blob takes at most one stack input and pushes its own constants, so nothing depends
            // on how verbatim orders several inputs.
            function txSigHash() -> v { v := verbatim_0i_1o(hex"6008b0") }      // TXPARAM(0x08) sig hash
            function txFrameIndex() -> v { v := verbatim_0i_1o(hex"600ab0") }   // TXPARAM(0x0a) current frame
            function txNumSigs() -> v { v := verbatim_0i_1o(hex"600bb0") }      // TXPARAM(0x0b) len(signatures)
            // SIGPARAM(param, i): [i] PUSH1 param SWAP1 SIGPARAM (i on top, param second)
            function sigSigner(i) -> v { v := verbatim_1i_1o(hex"600090b4", i) } // 0x00 resolved signer
            function sigScheme(i) -> v { v := verbatim_1i_1o(hex"600190b4", i) } // 0x01 scheme
            function sigMsg(i) -> v { v := verbatim_1i_1o(hex"600290b4", i) }    // 0x02 msg
            function sigLen(i) -> v { v := verbatim_1i_1o(hex"600390b4", i) }    // 0x03 len(signature)
            function frameScope(f) -> v { v := verbatim_1i_1o(hex"600690b3", f) } // FRAMEPARAM(0x06, f)
            // SIGDATACOPY(memOffset=0xa4, dataOffset=0, length=SIGPARAM(0x03,i), i):
            //   [i] DUP1 PUSH1 03 SWAP1 SIGPARAM -> [i len]; PUSH1 00; PUSH2 00a4; SIGDATACOPY
            function sigCopyTo0xa4(i) { verbatim_1i_0o(hex"80600390b460006100a4b5", i) }
            // APPROVE(offset 0, length 0, scope)
            function approve(scope) { verbatim_1i_0o(hex"60006000aa", scope) }

            function fail(code) {
                mstore(0x00, code)
                revert(0x00, 0x20)
            }

            // Verify ARBITRARY entry `idx` against the configured key over compute_sig_hash(tx). Reverts if invalid.
            function pqVerify(idx) {
                if iszero(lt(idx, txNumSigs())) { fail(0xb1) }
                if sigScheme(idx) { fail(0xb2) }    // must be ARBITRARY
                if sigMsg(idx) { fail(0xb3) }       // must sign the canonical sig hash (empty msg)
                let len := sigLen(idx)
                let want := loadimmutable("sigLen")
                if and(iszero(iszero(want)), iszero(eq(len, want))) { fail(0xb4) }

                let n := loadimmutable("nStatic")
                // header ends at 0xa4: selector(4) + n static words + digest + offset + length
                let base := sub(0x40, shl(5, n))
                mstore(base, loadimmutable("selector"))
                let p := add(base, 0x04)
                if gt(n, 0) {
                    mstore(p, loadimmutable("s0"))
                    p := add(p, 0x20)
                }
                if gt(n, 1) {
                    mstore(p, loadimmutable("s1"))
                    p := add(p, 0x20)
                }
                mstore(p, txSigHash())
                mstore(add(p, 0x20), shl(5, add(n, 2)))
                mstore(add(p, 0x40), len)
                sigCopyTo0xa4(idx)
                let inLen := sub(add(0xa4, and(add(len, 31), not(31))), base)
                // GAS immediately before STATICCALL: the one GAS use the VERIFY opcode rules allow.
                let ok := staticcall(gas(), loadimmutable("verifier"), base, inLen, 0x00, 0x20)
                if iszero(ok) { fail(0xb5) }
                if lt(returndatasize(), 0x20) { fail(0xb6) }
                if iszero(eq(mload(0x00), loadimmutable("okWord"))) { fail(0xb7) }
            }

            function send1(recipient) {
                if iszero(call(gas(), recipient, 1, 0, 0, 0, 0)) { fail(0xc1) }
            }

            if iszero(calldatasize()) { stop() }
            let op := shr(248, calldataload(0))
            switch op
            case 0x01 {
                pqVerify(0)
                let scope := frameScope(txFrameIndex())
                if iszero(scope) { fail(0xa1) }
                approve(scope)
            }
            case 0x02 {
                if iszero(lt(1, txNumSigs())) { fail(0xa2) }
                if iszero(eq(sigScheme(1), 1)) { fail(0xa3) } // SECP256K1
                if sigMsg(1) { fail(0xa4) }
                if iszero(eq(sigSigner(1), loadimmutable("payer"))) { fail(0xa5) }
                let scope := frameScope(txFrameIndex())
                if iszero(scope) { fail(0xa1) }
                approve(scope)
            }
            case 0x03 {
                if iszero(eq(caller(), address())) { fail(0xc0) }
                send1(shr(96, calldataload(1)))
            }
            case 0x04 {
                if iszero(eq(caller(), address())) { fail(0xc0) }
                pqVerify(0)
                send1(shr(96, calldataload(1)))
            }
            case 0x05 {
                if iszero(eq(caller(), address())) { fail(0xc0) }
                let len := sub(calldatasize(), 53)
                calldatacopy(0x00, 53, len)
                if iszero(call(gas(), shr(96, calldataload(1)), calldataload(21), 0x00, len, 0, 0)) { fail(0xc2) }
            }
            default { fail(0xff) }
        }
    }
}

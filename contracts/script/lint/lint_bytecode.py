#!/usr/bin/env python3
"""Opcode lint for VERIFY-reachable runtime bytecode (plan 10-contracts.md §10.1.4 item 2, 50-devnet-review rules).

Usage: lint_bytecode.py <name> <0x-runtime-hex>   (exit 1 on any violation)

Linear sweep of the runtime code (CBOR metadata stripped; the first INVALID (0xfe) is taken as the end of code,
which is where solc puts it), failing on:
  - opcodes banned in validation by EIP-8141 (public mempool) and ERC-8421 [OPCODES-*]:
    BALANCE GASPRICE BLOCKHASH COINBASE TIMESTAMP NUMBER PREVRANDAO GASLIMIT SELFBALANCE BASEFEE BLOBBASEFEE
    SLOTNUM SSTORE CREATE CREATE2 SETDELEGATE SELFDESTRUCT, and INVALID inside the code;
  - TLOAD / TSTORE (they revert in VERIFY on the devnet) and LOG0..LOG4 (VERIFY is static);
  - GAS (0x5a) not immediately followed by CALL / CALLCODE / DELEGATECALL / STATICCALL.
Static analysis is a pre-filter: the dynamic opcode test (VerifyOpcodes.t.sol) and the devnet
ethrex_simulateFrameTransaction trace are authoritative.
"""
import sys

BANNED = {
    0x31: "BALANCE", 0x3A: "GASPRICE", 0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER",
    0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x4A: "BLOBBASEFEE",
    0x4B: "SLOTNUM", 0x55: "SSTORE", 0x5C: "TLOAD", 0x5D: "TSTORE", 0xA0: "LOG0", 0xA1: "LOG1", 0xA2: "LOG2",
    0xA3: "LOG3", 0xA4: "LOG4", 0xF0: "CREATE", 0xF5: "CREATE2", 0xF6: "SETDELEGATE", 0xFF: "SELFDESTRUCT",
}
CALLS = {0xF1, 0xF2, 0xF4, 0xFA}


def strip_metadata(code: bytes) -> bytes:
    if len(code) >= 2:
        n = int.from_bytes(code[-2:], "big")
        if 0 < n <= len(code) - 2 and code[-2 - n] in (0xA1, 0xA2):  # CBOR map header
            return code[: -2 - n]
    return code


def lint(code: bytes):
    errors = []
    ops = []
    pc = 0
    while pc < len(code):
        op = code[pc]
        if op == 0xFE:
            break  # end of code; data / metadata follows
        ops.append((pc, op))
        pc += 1 + (op - 0x5F if 0x60 <= op <= 0x7F else 0)
    for i, (pc, op) in enumerate(ops):
        if op in BANNED:
            errors.append(f"pc {pc}: {BANNED[op]} (0x{op:02x})")
        if op == 0x5A and (i + 1 >= len(ops) or ops[i + 1][1] not in CALLS):
            nxt = f"0x{ops[i + 1][1]:02x}" if i + 1 < len(ops) else "end"
            errors.append(f"pc {pc}: GAS not followed by *CALL (next {nxt})")
    return errors, len(ops)


def main():
    name, hexcode = sys.argv[1], sys.argv[2].strip()
    code = strip_metadata(bytes.fromhex(hexcode[2:] if hexcode.startswith("0x") else hexcode))
    errors, n = lint(code)
    if errors:
        print(f"lint-verify: {name}: {len(errors)} violation(s) in {n} opcodes")
        for e in errors:
            print(f"  {e}")
        sys.exit(1)
    print(f"lint-verify: {name}: OK ({n} opcodes, {len(code)} bytes)")


if __name__ == "__main__":
    main()

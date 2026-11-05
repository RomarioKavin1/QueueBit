#!/usr/bin/env python3
# Pre-filter (plan §10.1.4 item 2): disassembles forge artifacts' runtime code and lists the opcodes the EIP-8141
# public mempool bans in the validation prefix, plus GAS not directly followed by a *CALL and TLOAD/TSTORE. The scan
# covers the whole runtime (not only VERIFY-reachable code), so execution-only SSTOREs show up and are expected;
# a lone trailing INVALID (0xfe) is solc's code/data separator. The devnet trace (ethrex_simulateFrameTransaction
# {trace:true}) is authoritative.
#   python3 lint-verify-opcodes.py <artifact.json>...
import json,sys
BAN={0x3a:'GASPRICE',0x40:'BLOCKHASH',0x41:'COINBASE',0x42:'TIMESTAMP',0x43:'NUMBER',0x44:'PREVRANDAO',0x45:'GASLIMIT',0x48:'BASEFEE',0x4a:'BLOBBASEFEE',0x4b:'SLOTNUM',0xf0:'CREATE',0xf5:'CREATE2',0xf6:'SETDELEGATE',0xff:'SELFDESTRUCT',0x31:'BALANCE',0x47:'SELFBALANCE',0x55:'SSTORE',0x5c:'TLOAD',0x5d:'TSTORE',0xfe:'INVALID'}
CALLS={0xf1,0xf2,0xf4,0xfa}
for f in sys.argv[1:]:
  code=bytes.fromhex(json.load(open(f))['deployedBytecode']['object'][2:])
  i=0;hits={}
  while i<len(code):
    op=code[i]
    if 0x60<=op<=0x7f: i+=op-0x5f+1; continue
    name=BAN.get(op)
    if op==0x5a and (i+1>=len(code) or code[i+1] not in CALLS): name='GAS(not before CALL)'
    if name: hits[name]=hits.get(name,0)+1
    i+=1
  print(f.split('/')[-1], hits)

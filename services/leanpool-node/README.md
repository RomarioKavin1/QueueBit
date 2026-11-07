# @queuebit/leanpool-node

The LeanPool node behind QueueBit's **post-quantum everyday key** (plan: `docs/plan/60-leanpool-merge-plan.md`).
Ported from LeanPool v2 (`ts/v2` @ `53732b1`), on Node 22+ and `@queuebit/frames`.

A wallet signs a payment's signature hash with leanVM leanSPHINCS (`@queuebit/lean-sphincs`) and sends
`{raw, sigs}` here. The node:

1. **verifies** the signature natively (lean-pq, ~0.2 ms) and checks the key is the sender's (`vk()`), and that the
   sender names this node's aggregator;
2. **gossips** EIP-8288 wrappers to its peers (mode 0 raw signatures every second; mode 1 recursive STARKs);
3. **batches** (aggregator): posts the Merkle root of the batch's dependencies to `DepsRegistry`, which writes it into
   each sender's ring; fills each transaction's witness `(root, ring, proof)` and delivers it to its ERC-8421 sidecar;
4. **proves** each posted batch in the background (a recursive leanVM STARK, ~1 min, ~195 KB) and attaches its hash
   on-chain; serves the STARK by that hash so anyone can audit the batch.

| Method | |
|---|---|
| `leanpool_sendTransaction [{raw, sigs}]` | → `{txHash}`: the payment's LeanPool id (its hash before the witness) |
| `leanpool_getTx [id]` | → `{stage, txHash?, batch?}`: `pooled` → `posted` → `submitted` → `mined` / `reverted` / `refused` |
| `leanpool_getStark [proofHash]` | → the batch's STARK bytes |
| `leanpool_status []` | → pool, batches, proofs, aggregator address, registry, bond |
| `leanpool_wrapper [hex]` | node to node: an EIP-8288 wrapper (validated, never trusted) |
| `GET /` | health |

## Run

```sh
pnpm --filter @queuebit/leanpool-node build
LEANPOOL_PRIVATE_KEY=0x… LEANPOOL_RPC_URL=https://altmempool.forshtat.com \
LEANPOOL_SIDECAR_URL=https://altmempool.forshtat.com/rpc LEANPOOL_REGISTRY=<DepsRegistry> \
LEANPOOL_AGGREGATE=1 LEANPOOL_AUTO_BOND_WEI=10000000000000000 node services/leanpool-node/dist/main.js
```

**PQ mode** (the public devnet's pinned aggregator): the aggregator identity is a `PQAggregator` contract
(`contracts/src/leanpool/PQAggregator.sol`). The node signs every root and proof hash with the contract's SPHINCS- C13
key (an EIP-712 digest of chain, contract, registry, nonce and fields; signed in a worker thread, ~2.3 s on an M3,
~16-25 s on a 2-core ARM server) and sends the signed call from `LEANPOOL_PRIVATE_KEY`, which then only pays gas.
`leanpool_status` reports `nodeId` = the contract, plus `gasPayer` and `pq` (public key, signatures used, budget). The
node refuses to start if the contract holds another key, and counts its signatures in `LEANPOOL_DATA_DIR/pq-signatures.json`
(C13 is few-time: 2^22 per key; posts stop 16 short, which the contract also enforces; rotate with `rotateKey`).

```sh
LEANPOOL_PQ_AGGREGATOR=<PQAggregator> LEANPOOL_PQ_KEY_FILE=…/.keys/pq-aggregator.json \
LEANPOOL_PRIVATE_KEY=0x<gas payer> … node services/leanpool-node/dist/main.js
```

`LEANPOOL_PQ_KEY` (64-byte hex `skSeed ‖ pkSeed ‖ pkRoot`) works instead of the file, which holds the same hex or a
JSON object with `secretKey`. The key is never logged. Deploying and bonding a PQAggregator: `devnet/deploy`
(`PQ_AGGREGATOR_PK=<public key>`). The Forge tests' C13 signatures come from `pnpm --filter @queuebit/leanpool-node
pin-vectors`.

Other settings (`src/config.ts`): `LEANPOOL_PORT` (8711), `LEANPOOL_HOST`, `LEANPOOL_PEERS` (comma-separated node
URLs), `LEANPOOL_BATCH_MS` (4000), `LEANPOOL_DATA_DIR`, `LEANPOOL_ROLLING`, `LEANPOOL_KEYSTORE` (a LeanPool ERC-8286
keystore for multi-signer txs), `LEANPOOL_CHAIN_ID`. Container: `Dockerfile`.

**Audit a batch** (anyone):

```sh
node services/leanpool-node/dist/verify-batch.js <root> --aggregator 0x… --registry 0x… \
  --rpc https://altmempool.forshtat.com --node http://127.0.0.1:8711
```

`VALID` means the recursive STARK whose hash is on-chain verifies and its claims rebuild the posted root, so every
committed payment is backed by a real leanSPHINCS signature.

## Trust

The aggregator can approve a payment the key did not sign: the EVM cannot verify leanVM signatures or STARKs yet, so
there is no on-chain slashing. In PQ mode that authority is a C13 key verified on chain; in ECDSA mode it is the
node's ECDSA key, which a quantum attacker could break. QueueBit bounds this with the account's everyday limits (the same bound as a leaked
everyday key), and a user moves to another aggregator through the Vault. See THREAT-MODEL.md.

## Tests

`pnpm --filter @queuebit/leanpool-node test` (STARK proving and merging: `test:slow`, minutes).

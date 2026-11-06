// LOCAL devnet e2e (devnet/up.sh): deposit → sync → prove → withdraw via the PoolPayer frame paymaster through the
// BUDGET-010 sidecar → the balance arrives. Opt-in: LOCAL_DEVNET=1 pnpm --filter @queuebit/privacy test.
// Needs `forge build` in contracts/ (reads contracts/out). Funding: anvil #5 (the privacy workstream's key) sends
// one top-up to this suite's own sub-account, which then does everything on its own nonce stream.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import * as snarkjs from "snarkjs";
import {
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  hexToBigInt,
  keccak256,
  numberToHex,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@queuebit/frames";
import { httpTransport } from "@queuebit/rpc";
import {
  DEFAULT_SIDECAR_URL,
  EncryptedStorage,
  FramePaymasterBroadcaster,
  NATIVE_ASSET,
  POOL_PAYER_ABI,
  PrivacyPoolsV1Client,
  QrEnvelopeSigner,
  createGroth16Prover,
  createHostProvider,
  createSignatureSecretManager,
  createWorkerProver,
  directNetwork,
  eip1193FromTransport,
  importStorageKey,
  loadPinnedArtifacts,
  memoryBackend,
  networkTransport,
  readPoolPayerRules,
  rootOf,
  serveProver,
  spendable,
  withdrawalClients,
  type PortLike,
} from "../src/index.js";
import { PAYER_KEY, vaultDevice } from "./helpers.js";

const RUN = process.env.LOCAL_DEVNET === "1";
const NODE = process.env.ETHREX_URL ?? "http://localhost:8545";
const SIDECAR = process.env.SIDECAR_URL ?? DEFAULT_SIDECAR_URL;
const REGISTRY: Address = "0x8464135c8F25Da09e49BC8782676a84730C318bC";
/** anvil #5 (public test key): the privacy workstream's funding key (devnet/README.md). */
const ANVIL5: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
/** This suite's own sub-account (a public, derived test key), funded from anvil #5. */
const SUB: Hex = keccak256(stringToHex("queuebit/privacy-package-e2e/v1"));
const OUT = new URL("../../../contracts/out/", import.meta.url).pathname;
const ART = new URL("../node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts/", import.meta.url).pathname;
const E = 10n ** 18n;

const rpc = httpTransport(NODE, { timeoutMs: 60_000 });
const q = <T>(m: string, p: unknown[] = []) => rpc.request<T>(m, p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (k: string, v: unknown) =>
  console.log(`[privacy e2e] ${k}: ${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);

async function receipt(
  hash: Hex,
  ms = 240_000,
): Promise<{ status: Hex; contractAddress: Address; blockNumber: Hex; gasUsed: Hex }> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await q<{ status: Hex; contractAddress: Address; blockNumber: Hex; gasUsed: Hex } | null>(
      "eth_getTransactionReceipt",
      [hash],
    ).catch(() => null);
    if (r) return r;
    await sleep(1000);
  }
  throw new Error(`no receipt for ${hash}`);
}

const nonces = new Map<Address, bigint>();
async function send(key: Hex, to: Address | null, data: Hex = "0x", value = 0n, gas?: bigint) {
  const a = privateKeyToAccount(key);
  if (gas === undefined) {
    const est = hexToBigInt(
      await q<Hex>("eth_estimateGas", [{ from: a.address, ...(to ? { to } : {}), data, value: numberToHex(value) }]),
    );
    const block = await q<{ gasLimit: Hex }>("eth_getBlockByNumber", ["latest", false]);
    const cap = hexToBigInt(block.gasLimit) - 2_000_000n;
    gas = (est * 5n) / 4n > cap ? cap : (est * 5n) / 4n;
  }
  const nonce = nonces.get(a.address) ?? hexToBigInt(await q<Hex>("eth_getTransactionCount", [a.address, "pending"]));
  nonces.set(a.address, nonce + 1n);
  const raw = await a.signTransaction({
    type: "legacy",
    chainId: 1337,
    nonce: Number(nonce),
    gasPrice: 2_000_000_000n,
    gas,
    ...(to ? { to } : {}),
    data,
    value,
  });
  const hash = await q<Hex>("eth_sendRawTransaction", [raw]);
  const r = await receipt(hash);
  if (r.status !== "0x1") throw new Error(`reverted: ${hash}`);
  return { hash, ...r };
}

function artifact(file: string) {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${file.replace(/\.sol$/, "")}.json`, "utf8"));
  return {
    abi: j.abi as Abi,
    bytecode: j.bytecode.object as Hex,
    links: (j.bytecode.linkReferences ?? {}) as Record<string, Record<string, { start: number; length: number }[]>>,
  };
}
async function deploy(file: string, args: unknown[] = [], libs: Record<string, Address> = {}) {
  const a = artifact(file);
  let code = a.bytecode.slice(2);
  for (const f of Object.values(a.links))
    for (const [lib, refs] of Object.entries(f))
      for (const { start, length } of refs)
        code = code.slice(0, start * 2) + libs[lib]!.slice(2).toLowerCase() + code.slice((start + length) * 2);
  const r = await send(SUB, null, encodeDeployData({ abi: a.abi, bytecode: `0x${code}`, args } as never));
  return { address: r.contractAddress, hash: r.hash, block: hexToBigInt(r.blockNumber) };
}
const call = (_to: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  encodeFunctionData({ abi, functionName, args } as never);

afterAll(async () => {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await curve?.terminate();
});

describe.skipIf(!RUN)("LOCAL devnet: deposit → sync → prove → PoolPayer withdrawal via the alt mempool", () => {
  it("the withdrawn ETH arrives at the fresh sender, at cost", async () => {
    // ---- funding: one top-up from anvil #5 to our sub-account ----------------------------------------------------
    const sub = privateKeyToAccount(SUB).address;
    const subBal = hexToBigInt(await q<Hex>("eth_getBalance", [sub, "latest"]));
    if (subBal < 2n * E) log("fund sub-account from anvil #5", (await send(ANVIL5, sub, "0x", 3n * E - subBal)).hash);
    log("sub-account", sub);

    // ---- Privacy Pools v1 (vendored 0xbow contracts) + PoolPayer -------------------------------------------------
    const verifier = await deploy("WithdrawalGroth16Verifier.sol");
    const t3 = await deploy("PoseidonT3.sol");
    const t4 = await deploy("PoseidonT4.sol");
    const impl = await deploy("Entrypoint.sol");
    const ep = artifact("Entrypoint.sol").abi;
    const proxy = await deploy("ERC1967Proxy.sol", [impl.address, call(impl.address, ep, "initialize", [sub, sub])]);
    const pool = await deploy("PrivacyPoolSimple.sol", [proxy.address, verifier.address, verifier.address], {
      PoseidonT3: t3.address,
      PoseidonT4: t4.address,
    });
    await send(SUB, proxy.address, call(proxy.address, ep, "registerPool", [NATIVE_ASSET, pool.address, 0n, 0n, 0n]));
    const payer = await deploy("PoolPayer.sol", [
      {
        devnet: 0,
        entrypoint: proxy.address,
        pool: pool.address,
        registry: REGISTRY,
        operator: sub,
        feeParam: 6,
        // Calibrated lower-bound estimator (IMPLEMENTATION-NOTES, PoolPayer after the security review).
        intrinsicGas: 21_000n,
        perFrameGas: 0n,
        gasPerDataByte: 4n,
        refundFrameGas: 23_000n,
        valueFrameGas: 0n,
        minPayStateGas: 183_600n,
        minSettleGas: 1_000_000n,
        minSettleStateGas: 1_000_000n,
        minRefundGas: 150_000n,
        minRefundStateGas: 183_600n,
      },
    ]);
    await send(SUB, payer.address, "0x", E / 2n, 100_000n);
    await send(
      SUB,
      payer.address,
      call(payer.address, artifact("PoolPayer.sol").abi, "stake", [86_400]),
      12n * 10n ** 15n,
      500_000n,
    );
    log("deployed", { entrypoint: proxy.address, pool: pool.address, poolPayer: payer.address });

    // ---- client: Host provider, vault signer over QR, encrypted cache, prover behind a worker port ---------------
    const net = directNetwork(); // local devnet: no Anon-RPC specifier here (§6.2), reads labelled unverified
    const provider = createHostProvider({ rpc: eip1193FromTransport(networkTransport(NODE, net, 60_000)) });
    let scans = 0;
    const vault = privateKeyToAccount(PAYER_KEY);
    const secrets = createSignatureSecretManager({
      signer: new QrEnvelopeSigner({ payer: vault.address, exchange: async (r) => (scans++, vaultDevice(r)) }),
      chainId: 1337n,
      entrypoint: proxy.address,
      cache: new EncryptedStorage({
        backend: memoryBackend(),
        namespace: "pp:1337:0:",
        key: await importStorageKey(crypto.getRandomValues(new Uint8Array(32))),
      }),
    });
    const ch = new MessageChannel();
    serveProver(
      ch.port2 as unknown as PortLike,
      createGroth16Prover({
        backend: snarkjs.groth16,
        artifacts: () => loadPinnedArtifacts(async (n) => new Uint8Array(readFileSync(ART + n))),
      }),
    );
    const prover = createWorkerProver(ch.port1 as unknown as PortLike);
    const aspLabels: bigint[] = [];
    const client = new PrivacyPoolsV1Client({
      provider,
      chainId: 1337n,
      entrypoint: proxy.address,
      pool: pool.address,
      deployBlock: pool.block,
      secrets,
      asp: { getLabels: async () => [...aspLabels] },
      prover,
    });

    // ---- deposit (precommitment from a vault envelope signature) -------------------------------------------------
    await client.sync();
    const dep = await client.prepareDeposit(E / 10n);
    expect(dep.depositIndex).toBe(0);
    const depTx = await send(SUB, dep.tx.to, dep.tx.data, dep.tx.value);
    log("deposit", { tx: depTx.hash, scans });

    // ---- the ASP (we are the postman on this devnet) approves the label; sync verifies both roots -----------------
    await client.sync();
    const ourDeposit = client.state!.deposits.find((d) => d.precommitment === dep.precommitment)!;
    aspLabels.push(ourDeposit.label);
    const ur = await send(
      SUB,
      proxy.address,
      call(proxy.address, ep, "updateRoot", [
        rootOf(aspLabels),
        "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      ]),
    );
    await client.sync();
    const notes = spendable((await client.notes()).notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.value).toBe(E / 10n);
    log("synced", { updateRoot: ur.hash, leaves: client.state!.leaves.length, syncedTo: client.state!.syncedTo });

    // ---- withdraw 0.05 ETH via PoolPayer through the BUDGET-010 sidecar -----------------------------------------
    const broadcaster = new FramePaymasterBroadcaster({
      // The withdrawal's own circuit (devnet: no Anon-RPC, so direct and labelled; plan §6.2).
      ...withdrawalClients({ nodeUrl: NODE, sidecarUrl: SIDECAR, timeoutMs: 60_000 }),
      profile: getProfile("ethrex-eip8141-tracer"),
      chainId: 1337n,
      payer: payer.address,
      rules: await readPoolPayerRules(provider, payer.address),
      fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
      timeoutMs: 240_000,
    });
    const amount = E / 20n;
    const statuses: string[] = [];
    const out = await client.withdrawViaPoolPayer({
      note: notes[0]!,
      amount,
      broadcaster,
      onStatus: (s) => statuses.push(s),
    });
    prover.close();
    ch.port1.close();

    // ---- the balance arrived: amount − fee + refund, to the wei ---------------------------------------------------
    const logs = out.receipt.frameReceipts.flatMap((f) => f.logs);
    const events = logs.flatMap((l) => {
      try {
        return [decodeEventLog({ abi: POOL_PAYER_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] })];
      } catch {
        return [];
      }
    });
    const refunded = events.find((e) => e.eventName === "Refunded")!.args as { amount: bigint; costEstimate: bigint };
    const settled = events.find((e) => e.eventName === "Settled")!.args as { paid: bigint; fee: bigint };
    const bal = hexToBigInt(await q<Hex>("eth_getBalance", [out.sender, "latest"]));
    log("withdrawal", {
      hash: out.hash,
      status: out.status,
      statuses,
      sender: out.sender,
      fee: out.fee,
      refund: refunded.amount,
      costEstimate: refunded.costEstimate,
      received: bal,
      frames: out.receipt.frameReceipts.map((f) => [f.status, f.gasUsed]),
    });
    expect(out.receipt.frameReceipts.map((f) => f.status)).toEqual(["success", "success", "success", "success"]);
    expect(settled.fee).toBe(out.fee);
    expect(settled.paid).toBe(amount - out.fee);
    expect(bal).toBe(amount - out.fee + refunded.amount);
    expect(bal > (amount * 9n) / 10n).toBe(true);

    // ---- the change note is found again from the vault-derived secrets ------------------------------------------
    await client.sync();
    const after = (await client.notes()).notes;
    expect(after.map((n) => [n.depositIndex, n.secretIndex, n.value, n.status])).toEqual([
      [0, 1, E / 10n - amount, "approved"],
    ]);
  }, 900_000);
});

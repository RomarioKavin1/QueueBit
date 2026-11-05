// LEAKED component probe: validation-gas ceilings per mempool, and a PORST-validated frame tx.
// Usage: npx tsx probe.ts <phase>   phases: deploy | gas | stake | gas-staked | porst | porst-staked
import fs from "node:fs";
import { encodeAbiParameters, encodeDeployData, keccak256, numberToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as lib from "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/node_modules/@forshtat/hegota-support/dist/tx/index.js";
import { profile } from "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/frameTx/profile.ts";
import { buildStakeTx, signFrameTx, txHash } from "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/frameTx/build.ts";
import { accountNonce, sendFrameTx, sendRawFrameTx, waitForReceipt } from "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/frameTx/send.ts";
import { sendLegacy, waitMined, getBalance } from "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/chain.ts";
import { loadConfig } from "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/config.ts";
import { ensureParticipantKey } from "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/state.ts";

const STATE = "/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/probe/probe-state.json";
const st: Record<string, any> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const cfg = loadConfig();
const key = ensureParticipantKey();
const owner = privateKeyToAccount(key).address;
const art = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

async function deploy(bytecode: Hex, abi: any, args: unknown[], value: bigint): Promise<Address> {
  const h = await sendLegacy(key, { to: null, data: encodeDeployData({ abi, bytecode, args }), value, gas: 9_000_000n });
  const r = await waitMined(h);
  if (r.status !== "0x1") throw new Error("deploy reverted " + h);
  return r.contractAddress as Address;
}

// ---- PORST key: preimages[i] = keccak256(uint256 i), same as duncancmt/porst's test (demo key, not secret) ----
const H = 16, K = 38, N = 1 << H;
let tree: Hex[] = [], pre: Hex[] = [];
function buildTree() {
  if (tree.length) return;
  tree = new Array(2 * N);
  for (let i = 0; i < N; i++) {
    pre[i] = keccak256(numberToHex(i, { size: 32 }));
    tree[N + i] = keccak256(pre[i]);
  }
  for (let i = N - 1; i > 0; i--) tree[i] = keccak256(("0x" + tree[2 * i].slice(2) + tree[2 * i + 1].slice(2)) as Hex);
}
const cat = (...xs: Hex[]) => ("0x" + xs.map((x) => x.slice(2)).join("")) as Hex;
function subset(salt: Hex, hash: Hex): number[] {
  const S = keccak256(cat(hash, salt));
  let seedState: Hex = numberToHex(0, { size: 32 }), seedVal = 0n, seedCount = 256 / H;
  const out: number[] = [];
  while (out.length < K) {
    if (seedCount >= 256 / H) { seedState = keccak256(cat(seedState, S)); seedVal = BigInt(seedState); seedCount = 0; }
    seedCount++;
    const sel = Number(seedVal & BigInt(N - 1)); seedVal >>= BigInt(H);
    let lo = 0; while (lo < out.length && out[lo] < sel) lo++;
    if (out[lo] === sel) continue;
    out.splice(lo, 0, sel);
  }
  return out;
}
const msb = (x: number) => 31 - Math.clz32(x);
function porstSign(salt: Hex, hash: Hex): Hex {
  const sub = subset(salt, hash);
  const elems: Hex[] = [];
  const frontier: (Hex | null)[] = new Array(H + 1).fill(null);
  for (let idx = 0; idx < K; idx++) {
    const i = sub[idx];
    const park = idx + 1 < K ? msb(i ^ sub[idx + 1]) : H;
    elems.push(pre[i]);
    let node = keccak256(pre[i]);
    for (let lvl = 0; lvl < park; lvl++) {
      const c = (i >> lvl) & 1, sib = ((N + i) >> lvl) ^ 1;
      if (c === 0) { elems.push(tree[sib]); node = keccak256(cat(node, tree[sib])); }
      else if (frontier[lvl] === null) { elems.push(tree[sib]); node = keccak256(cat(tree[sib], node)); }
      else { node = keccak256(cat(frontier[lvl]!, node)); frontier[lvl] = null; }
    }
    frontier[park] = node;
  }
  return cat(salt, ...elems);
}

const fr = (mode: string, scope: string | undefined, target: Address | null, execution: bigint, o: any = {}) =>
  lib.frame(profile, mode, { scope, target, execution, ...o });

async function verdicts(label: string, tx: any) {
  const res: any = { label, txHash: txHash(tx) };
  try { await sendRawFrameTx(tx); res.canonical = "ACCEPTED"; } catch (e: any) { res.canonical = "rejected: " + String(e.message).slice(0, 260); }
  if (res.canonical !== "ACCEPTED") {
    try { await sendFrameTx(tx); res.alt = "ACCEPTED"; } catch (e: any) { res.alt = "rejected: " + String(e.message).slice(0, 260); }
  } else res.alt = "(not sent: canonical took it)";
  if (res.canonical === "ACCEPTED" || res.alt === "ACCEPTED") {
    try { const r: any = await waitForReceipt(res.txHash); res.mined = Number(r.blockNumber); res.gasUsed = r.gasUsed; res.frames = r.frameReceipts?.map((f: any) => f.gasUsed ?? f.status); } catch (e: any) { res.mined = "FAILED " + e.message.slice(0, 160); }
  }
  console.log(JSON.stringify(res, null, 1));
  return res;
}

function gasTx(wallet: Address, nonce: bigint, iters: number, verifyLimit: bigint) {
  return lib.newTx({
    chainId: cfg.chainId, sender: wallet, nonceSeq: nonce,
    frames: [fr("VERIFY", "EXECUTION_AND_PAYMENT", null, verifyLimit, { data: encodeAbiParameters([{ type: "uint256" }], [BigInt(iters)]) }),
             fr("SENDER", undefined, cfg.recipient, 50_000n, { value: 1n, state: 200_000n })],
    signatures: [lib.secp256k1Placeholder(profile, owner)], fees: { maxFeePerGas: cfg.maxFeePerGasWei },
  });
}

async function porstTx(wallet: Address, nonce: bigint, verifyLimit: bigint) {
  buildTree();
  const L = 32 + 32 * 400; // fixed witness length, ground to by salt
  const base = (sig: Hex) => lib.newTx({
    chainId: cfg.chainId, sender: wallet, nonceSeq: nonce,
    frames: [fr("VERIFY", "EXECUTION_AND_PAYMENT", null, verifyLimit),
             fr("SENDER", undefined, cfg.recipient, 50_000n, { value: 1n, state: 200_000n })],
    signatures: [{ scheme: lib.sigScheme(profile, "ARBITRARY"), signer: "0x", msg: "0x", signature: sig }],
    fees: { maxFeePerGas: cfg.maxFeePerGasWei },
  });
  const h = lib.sigHash(profile, base(("0x" + "00".repeat(L)) as Hex));
  const lens: number[] = [];
  for (let s = 0; s < 5000; s++) {
    const sig = porstSign(numberToHex(s, { size: 32 }), h);
    lens.push((sig.length - 2) / 2);
    if ((sig.length - 2) / 2 === L) {
      const tx = base(sig);
      if (lib.sigHash(profile, tx) !== h) throw new Error("sig hash changed");
      console.log(JSON.stringify({ porst: { witnessBytes: L, saltTries: s + 1, sigHash: h, minLen: Math.min(...lens), maxLen: Math.max(...lens) } }));
      return tx;
    }
  }
  throw new Error("no salt hit length; lengths seen " + Math.min(...lens) + ".." + Math.max(...lens));
}

const phase = process.argv[2];
if (phase === "deploy") {
  buildTree();
  const pa = art("/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/probe/../porst-dl/porst/out/PORST.sol/PORST.json");
  st.root = tree[1];
  st.porst = await deploy(pa.bytecode.object, pa.abi, [tree[1]], 0n);
  const ga = art("/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/probe/contracts/out/ProbeWallets.sol/GasProbeWallet.json");
  st.gasWallet = await deploy(ga.bytecode.object, ga.abi, [owner], 50_000_000_000_000_000n);
  const pw = art("/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/probe/contracts/out/ProbeWallets.sol/PorstWallet.json");
  st.porstWallet = await deploy(pw.bytecode.object, pw.abi, [owner, st.porst], 50_000_000_000_000_000n);
  save(); console.log(st);
} else if (phase === "gas" || phase === "gas-staked") {
  for (const [iters, limit] of [[200, 90_000n], [200, 150_000n], [1500, 300_000n], [6000, 1_200_000n]] as [number, bigint][]) {
    const tx = await signFrameTx(gasTx(st.gasWallet, await accountNonce(st.gasWallet), iters, limit), key);
    await verdicts(phase + " iters=" + iters + " verifyLimit=" + limit, tx);
  }
} else if (phase === "stake") {
  for (const w of [st.gasWallet, st.porstWallet]) {
    const tx = await signFrameTx(buildStakeTx({ registry: cfg.stakingRegistry, wallet: w, owner, amount: 12_000_000_000_000_000n, unstakeDelaySec: 86400, nonce: await accountNonce(w), chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei }), key);
    await sendFrameTx(tx); await waitForReceipt(txHash(tx)); console.log("staked", w, txHash(tx));
  }
} else if (phase === "porst" || phase === "porst-staked") {
  const tx = await porstTx(st.porstWallet, await accountNonce(st.porstWallet), 400_000n);
  await verdicts(phase + " PORST vault tx verifyLimit=400000", tx);
} else if (phase === "hot") {
  const tx = await signFrameTx(lib.newTx({ chainId: cfg.chainId, sender: st.porstWallet, nonceSeq: await accountNonce(st.porstWallet),
    frames: [fr("VERIFY", "EXECUTION_AND_PAYMENT", null, 80_000n), fr("SENDER", undefined, cfg.recipient, 50_000n, { value: 1n, state: 200_000n })],
    signatures: [lib.secp256k1Placeholder(profile, owner)], fees: { maxFeePerGas: cfg.maxFeePerGasWei } }), key);
  await verdicts("hot-key path on PorstWallet", tx);
}
if (phase === "porst-call") {
  buildTree();
  const { createPublicClient, http, parseAbi } = await import("viem");
  const pc = createPublicClient({ transport: http("https://altmempool.forshtat.com") });
  const abi = parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)", "function pubkey() view returns (bytes32)"]);
  console.log("onchain pubkey matches TS root:", (await pc.readContract({ address: st.porst, abi, functionName: "pubkey" })) === tree[1]);
  for (const [salt, msg] of [["0x" + "00".repeat(31) + "2a", keccak256("0x1234")], ["0x" + "00".repeat(31) + "07", keccak256("0xbeef")]] as [Hex, Hex][]) {
    const sig = porstSign(salt, msg);
    const data = (await import("viem")).encodeFunctionData({ abi, functionName: "isValidSignature", args: [msg, sig] });
    const ok = await pc.readContract({ address: st.porst, abi, functionName: "isValidSignature", args: [msg, sig] });
    const gas = await pc.estimateGas({ to: st.porst, data, account: owner });
    const bad = await pc.readContract({ address: st.porst, abi, functionName: "isValidSignature", args: [keccak256("0x00"), sig] });
    console.log(JSON.stringify({ sigBytes: (sig.length - 2) / 2, valid: ok, wrongMsgResult: bad, estimateGasTotal: gas.toString() }));
  }
}
if (phase === "porst-estimate") {
  const tx = await porstTx(st.porstWallet, await accountNonce(st.porstWallet), 400_000n);
  const { toWire } = await import("/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/frameTx/build.ts");
  const { rpc } = await import("/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/rpc.ts");
  for (const m of ["eth_estimateFrameTransactionGas"]) {
    try { console.log(m, JSON.stringify(await rpc("https://altmempool.forshtat.com/rpc", m, [toWire(tx)])).slice(0, 1500)); } catch (e: any) { console.log(m, "ERR", String(e.message).slice(0, 400)); }
  }
  try { console.log("ethrex_simulate", JSON.stringify(await rpc("https://altmempool.forshtat.com", "ethrex_simulateFrameTransaction", [toWire(tx)])).slice(0, 2500)); } catch (e: any) { console.log("ethrex_simulate ERR", String(e.message).slice(0, 400)); }
}
if (phase === "exec-deploy") {
  const a = art("/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/probe/contracts/out/ProbeWallets.sol/ExecPorstWallet.json");
  st.execWallet = await deploy(a.bytecode.object, a.abi, [owner, st.porst], 50_000_000_000_000_000n); save(); console.log("execWallet", st.execWallet);
}
if (phase === "exec-porst" || phase === "exec-porst-badsig") {
  buildTree();
  const { encodeFunctionData, parseAbi } = await import("viem");
  const data = encodeFunctionData({ abi: parseAbi(["function vaultSend(address,uint256)"]), functionName: "vaultSend", args: [cfg.recipient, 12345n] });
  const L = 32 + 32 * 400;
  const base = (sig: Hex) => lib.newTx({
    chainId: cfg.chainId, sender: st.execWallet, nonceSeq: await_nonce,
    frames: [fr("VERIFY", "EXECUTION_AND_PAYMENT", null, 60_000n), fr("SENDER", undefined, null, 600_000n, { data })],
    signatures: [{ scheme: lib.sigScheme(profile, "ARBITRARY"), signer: "0x", msg: "0x", signature: sig }, lib.secp256k1Placeholder(profile, owner)],
    fees: { maxFeePerGas: cfg.maxFeePerGasWei },
  });
  var await_nonce = await accountNonce(st.execWallet);
  const h = lib.sigHash(profile, base(("0x" + "00".repeat(L)) as Hex));
  let sig: Hex | null = null, tries = 0;
  for (let s = 0; s < 5000 && !sig; s++) { tries++; const c = porstSign(numberToHex(s, { size: 32 }), phase === "exec-porst-badsig" ? keccak256("0xdead") : h); if ((c.length - 2) / 2 === L) sig = c; }
  let tx = base(sig!);
  if (lib.sigHash(profile, tx) !== h) throw new Error("sig hash changed");
  tx = await lib.signTx(profile, tx, key, 1);
  const before = await getBalance(cfg.recipient);
  const r = await verdicts(phase + " (PORST in execution frame, " + tries + " salt tries)", tx);
  console.log("recipient delta wei:", (await getBalance(cfg.recipient)) - before);
  if (r.mined) { const { rpc } = await import("/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/ws-dl/mempool-workshop/src/lib/rpc.ts"); const rc: any = await rpc("https://altmempool.forshtat.com", "eth_getTransactionReceipt", [r.txHash]); console.log(JSON.stringify({ status: rc.status, gasUsed: rc.gasUsed ? BigInt(rc.gasUsed).toString() : rc.cumulativeGasUsed, frameReceipts: rc.frameReceipts?.map((f: any) => ({ status: f.status, gasUsed: f.gasUsed })) })); }
}
if (phase === "tpm-deploy") {
  const A = (n: string) => art(`/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/e6ce86e4-fa86-4425-924e-76c13ca8b363/scratchpad/probe/contracts/out/TokenPaymaster.sol/${n}.json`);
  const t = A("MockUSD"), w = A("ExecOnlyWallet"), p = A("TokenPaymaster");
  st.mockUsd = await deploy(t.bytecode.object, t.abi, [], 0n);
  st.execOnly = await deploy(w.bytecode.object, w.abi, [owner], 0n);
  st.tpm = await deploy(p.bytecode.object, p.abi, [st.mockUsd, 1_000_000n], 50_000_000_000_000_000n);
  const { encodeFunctionData, parseAbi } = await import("viem");
  await waitMined(await sendLegacy(key, { to: st.mockUsd, data: encodeFunctionData({ abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [st.execOnly, 5_000_000n] }) }));
  save(); console.log({ mockUsd: st.mockUsd, execOnly: st.execOnly, tpm: st.tpm, walletEthBalance: await getBalance(st.execOnly) });
}
if (phase === "tpm-stake") {
  const { encodeFunctionData, parseAbi } = await import("viem");
  const r = await waitMined(await sendLegacy(key, { to: st.tpm, value: 12_000_000_000_000_000n, gas: 300_000n, data: encodeFunctionData({ abi: parseAbi(["function stake() payable"]), functionName: "stake" }) }));
  console.log("paymaster stake tx status", r.status);
}
if (phase === "tpm" || phase === "tpm-staked" || phase === "tpm-nofee") {
  const { encodeFunctionData, parseAbi } = await import("viem");
  const abi = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  const feeData = encodeFunctionData({ abi, functionName: "transfer", args: [phase === "tpm-nofee" ? cfg.recipient : st.tpm, 1_000_000n] });
  const payData = encodeFunctionData({ abi, functionName: "transfer", args: [cfg.recipient, 250_000n] });
  const tx = await signFrameTx(lib.newTx({ chainId: cfg.chainId, sender: st.execOnly, nonceSeq: await accountNonce(st.execOnly),
    frames: [fr("VERIFY", "EXECUTION", null, BigInt(process.env.WV ?? "25000")), fr("VERIFY", "PAYMENT", st.tpm, BigInt(process.env.PV ?? "72000")),
             fr("SENDER", undefined, st.mockUsd, 60_000n, { data: feeData, state: 100_000n }), fr("SENDER", undefined, st.mockUsd, 60_000n, { data: payData, state: 100_000n })],
    signatures: [lib.secp256k1Placeholder(profile, owner)], fees: { maxFeePerGas: cfg.maxFeePerGasWei } }), key);
  const { createPublicClient, http } = await import("viem");
  const pc = createPublicClient({ transport: http("https://altmempool.forshtat.com") });
  const bal = async (a: Address) => pc.readContract({ address: st.mockUsd, abi, functionName: "balanceOf", args: [a] });
  const b0 = { wallet: await bal(st.execOnly), pm: await bal(st.tpm), pmEth: await getBalance(st.tpm), walletEth: await getBalance(st.execOnly) };
  await verdicts(phase + " (wallet has 0 ETH, pays fee in mock USD)", tx);
  console.log(JSON.stringify({ before: b0, after: { wallet: await bal(st.execOnly), pm: await bal(st.tpm), pmEth: await getBalance(st.tpm), walletEth: await getBalance(st.execOnly) } }, (_, v) => typeof v === "bigint" ? v.toString() : v));
}

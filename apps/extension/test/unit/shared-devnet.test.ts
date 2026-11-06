import { readFileSync } from "node:fs";
import { getAddress, keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { Network } from "../../src/shared/chains";
import {
  SHARED_NETWORK_NAME,
  applySharedConfig,
  failSharedNetworks,
  loadSharedDevnet,
  normalizeBase,
  parseSharedAddresses,
  requestFaucet,
  sharedNetworks,
  sharedUrls,
  type SharedIo,
} from "../../src/shared/sharedDevnet";

// The same shape the devnet gateway serves at /addresses.json: {chain1337, chain31337} = the devnet/deploy records.
const read = (f: string) =>
  JSON.parse(readFileSync(new URL(`../../../../devnet/deploy/${f}`, import.meta.url), "utf8"));
const FILE = { chain1337: read("addresses.local.json"), chain31337: read("addresses.anvil4337.json") };
const clone = () => JSON.parse(JSON.stringify(FILE));
const BASE = "https://example-tunnel.trycloudflare.com";
const FACTORY_CODE: Hex = "0x6080604052deadbeef";
const FACTORY_HASH = keccak256(FACTORY_CODE);

function fakeIo(
  o: { file?: unknown; chain1337?: string; chain31337?: string; factoryCode?: Hex; noCode?: string[] } = {},
) {
  const calls: string[] = [];
  const io: SharedIo = {
    async fetchJson(url) {
      calls.push(`GET ${url}`);
      if (url !== `${BASE}/addresses.json`) throw new Error("wrong url");
      return o.file ?? FILE;
    },
    async rpc(url, method, params) {
      calls.push(`${url} ${method}`);
      if (method === "eth_chainId")
        return url.endsWith("/4337/rpc") ? (o.chain31337 ?? "0x7a69") : (o.chain1337 ?? "0x539");
      const a = String(params[0]).toLowerCase();
      if (o.noCode?.some((x) => x.toLowerCase() === a)) return "0x";
      if (a === FILE.chain1337.contracts.AccountFactory.address.toLowerCase()) return o.factoryCode ?? FACTORY_CODE;
      return "0x60016000";
    },
  };
  return { io, calls };
}

describe("shared devnet: base URL", () => {
  it("accepts an https origin and derives the fixed paths", () => {
    expect(normalizeBase(" https://a-b-c.trycloudflare.com/ ")).toBe("https://a-b-c.trycloudflare.com");
    expect(sharedUrls(BASE)).toMatchObject({
      rpc: `${BASE}/rpc`,
      sidecar: `${BASE}/sidecar`,
      stakedSidecar: `${BASE}/sidecar-staked`,
      rpc4337: `${BASE}/4337/rpc`,
      bundler: `${BASE}/4337/bundler`,
      faucet: `${BASE}/faucet`,
      addresses: `${BASE}/addresses.json`,
      companion: `${BASE}/companion/`,
    });
  });

  it("refuses http (except localhost), paths, queries and credentials", () => {
    for (const bad of [
      "http://x.trycloudflare.com",
      "https://x.trycloudflare.com/rpc",
      "https://x.trycloudflare.com/?a=1",
      "https://u:p@x.trycloudflare.com",
      "not a url",
      "javascript:alert(1)",
    ])
      expect(() => normalizeBase(bad), bad).toThrow();
    expect(normalizeBase("http://localhost:8080")).toBe("http://localhost:8080");
  });
});

describe("shared devnet: addresses.json validation", () => {
  it("parses the gateway's file into the frame deployment, the 4337 stack and the test tokens", () => {
    const p = parseSharedAddresses(FILE);
    expect(p.deployment.factory).toBe(FILE.chain1337.contracts.AccountFactory.address);
    expect(p.deployment.accountImpl).toBe(FILE.chain1337.contracts.QueueBitAccountImpl.address);
    expect(p.aa?.factory).toBe(FILE.chain31337.contracts.MSAFactory.address);
    expect(p.aa?.validator).toBe(FILE.chain31337.contracts.QueueBitHotValidator.address);
    expect(p.tokens1337.find((t) => t.symbol === "USDC")).toMatchObject({ usd: 1, permit: true, preselected: true });
    expect(p.privacy).toBeUndefined();
    const withPool = {
      ...clone(),
      privacy1337: {
        entrypoint: "0xde6407deff80a5296fead73892c7c5a32612d67a",
        pool: "0x8b4d48d5a4b26699886bed6cd20b1582722dc086",
        poolPayer: "0xeee764ac5f86e488250dc9fb5224adedda56c1cb",
        deployBlock: "695",
      },
    };
    expect(parseSharedAddresses(withPool).privacy).toMatchObject({
      pool: getAddress("0x8b4d48d5a4b26699886bed6cd20b1582722dc086"),
      deployBlock: "695",
    });
    expect(parseSharedAddresses({ ...clone(), privacy1337: { pool: "junk" } }).privacy).toBeUndefined();
  });

  it("fails on a wrong chain id, a bad address or a missing contract", () => {
    const wrongChain = clone();
    wrongChain.chain1337.network.chainId = 1;
    expect(() => parseSharedAddresses(wrongChain)).toThrow(/not for chain 1337/u);
    const wrong4337 = clone();
    wrong4337.chain31337.network.chainId = 1337;
    expect(() => parseSharedAddresses(wrong4337)).toThrow(/not for chain 31337/u);
    const badAddr = clone();
    badAddr.chain1337.contracts.AccountFactory.address = "0x1234";
    expect(() => parseSharedAddresses(badAddr)).toThrow(/AccountFactory isn't an address/u);
    const missing = clone();
    delete missing.chain1337.contracts.RoleSignerFactory;
    expect(() => parseSharedAddresses(missing)).toThrow(/RoleSignerFactory/u);
    const badToken = clone();
    badToken.chain1337.tokens.USDC.symbol = "<script>";
    expect(() => parseSharedAddresses(badToken)).toThrow(/symbol/u);
    expect(() => parseSharedAddresses(null)).toThrow();
    expect(() => parseSharedAddresses({})).toThrow(/chain1337/u);
  });
});

describe("shared devnet: checks against the chain (fail closed)", () => {
  it("loads when the chain ids and the factory code hash match", async () => {
    const { io, calls } = fakeIo();
    const cfg = await loadSharedDevnet(BASE, io, FACTORY_HASH);
    expect(cfg.base).toBe(BASE);
    expect(cfg.aa).toBeDefined();
    expect(cfg.aaError).toBeUndefined();
    expect(calls).toContain(`${BASE}/rpc eth_chainId`);
    expect(calls).toContain(`${BASE}/4337/rpc eth_chainId`);
  });

  it("refuses a factory whose code differs from the bundled artifact", async () => {
    const { io } = fakeIo({ factoryCode: "0x6080604052cafebabe" });
    await expect(loadSharedDevnet(BASE, io, FACTORY_HASH)).rejects.toThrow(/account factory isn't the one/u);
  });

  it("refuses an RPC on another chain", async () => {
    const { io } = fakeIo({ chain1337: "0x1" });
    await expect(loadSharedDevnet(BASE, io, FACTORY_HASH)).rejects.toThrow(/chain 1, not the shared devnet/u);
  });

  it("refuses when a contract has no code", async () => {
    const { io } = fakeIo({ noCode: [FILE.chain1337.contracts.QueueBitAccountImpl.address] });
    await expect(loadSharedDevnet(BASE, io, FACTORY_HASH)).rejects.toThrow(/no account implementation/u);
  });

  it("an unreachable devnet says to check the URL", async () => {
    const io: SharedIo = { fetchJson: () => Promise.reject(new Error("offline")), rpc: () => Promise.resolve("0x") };
    await expect(loadSharedDevnet(BASE, io, FACTORY_HASH)).rejects.toThrow(
      /Can't reach the shared devnet.*URL changed/u,
    );
  });

  it("a bad 4337 part only turns the 4337 network off", async () => {
    const { io } = fakeIo({ chain31337: "0x1" });
    const cfg = await loadSharedDevnet(BASE, io, FACTORY_HASH);
    expect(cfg.aa).toBeUndefined();
    expect(cfg.aaError).toMatch(/not 31337/u);
    const nets = sharedNetworks(BASE) as Network[];
    applySharedConfig(nets, cfg);
    expect(nets[0]!.enabled).toBe(true);
    expect(nets[1]!.enabled).toBe(false);
    expect(nets[1]!.disabledReason).toMatch(/not 31337/u);
  });
});

describe("shared devnet: network entries", () => {
  it("start unselectable, are filled in by a checked config, and turn off again on failure", async () => {
    const nets = sharedNetworks(BASE) as Network[];
    expect(nets[0]).toMatchObject({ chainId: 1337, name: SHARED_NETWORK_NAME, backend: "frame", enabled: false });
    expect(nets[0]!.rpcUrl).toBe(`${BASE}/rpc`);
    expect(nets[1]).toMatchObject({ chainId: 31337, backend: "4337", bundlerUrl: `${BASE}/4337/bundler` });
    const other = "https://moved.trycloudflare.com";
    const { io } = fakeIo();
    const cfg = await loadSharedDevnet(BASE, io, FACTORY_HASH);
    applySharedConfig(nets, { ...cfg, base: other, urls: sharedUrls(other) });
    expect(nets[0]!.enabled).toBe(true);
    expect(nets[0]!.deployment?.factory).toBe(FILE.chain1337.contracts.AccountFactory.address);
    expect(nets[0]!.sidecarUrl).toBe(`${other}/sidecar`);
    expect(nets[1]!.aa?.entryPoint).toBe("0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
    failSharedNetworks(nets, "gone");
    expect(nets.every((n) => !n.enabled && n.disabledReason === "gone" && !n.deployment && !n.aa)).toBe(true);
  });
});

describe("shared devnet: faucet", () => {
  it("asks <base>/faucet for the address (and the chain when not 1337) and reports the server's error", async () => {
    const seen: string[] = [];
    const ok = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ txHash: `0x${"1".repeat(64)}`, amountWei: "1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = "0x00000000000000000000000000000000000000aa";
    expect(await requestFaucet(BASE, a, 1337, ok)).toMatchObject({ txHash: `0x${"1".repeat(64)}` });
    await requestFaucet(BASE, a, 31337, ok);
    expect(seen[0]).toBe(`${BASE}/faucet?address=0x00000000000000000000000000000000000000AA`);
    expect(seen[1]).toContain("&chain=31337");
    const limited = (async () =>
      new Response(JSON.stringify({ error: "one drip per IP per 10 min; retry in 60 s" }), {
        status: 429,
      })) as unknown as typeof fetch;
    await expect(requestFaucet(BASE, a, 1337, limited)).rejects.toThrow(/per IP/u);
    await expect(requestFaucet(BASE, "0xnope", 1337, ok)).rejects.toThrow(/Not an address/u);
  });
});

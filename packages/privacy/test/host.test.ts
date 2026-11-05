import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import {
  EncryptedStorage,
  KeystorePathNotAllowedError,
  StorageIntegrityError,
  StorageLockedError,
  VaultKeystore,
  anonNetwork,
  chromeStorageBackend,
  createHostProvider,
  freshIsolationKey,
  heliosVerifiedReads,
  importStorageKey,
  isolationKeyFor,
  memoryBackend,
  networkTransport,
  type AnonRequestInit,
} from "../src/index.js";

const key32 = (b: number) => new Uint8Array(32).fill(b);

describe("EncryptedStorage (Host storage)", () => {
  it("round-trips, and the backend only ever holds ciphertext", async () => {
    const be = memoryBackend();
    const s = new EncryptedStorage({ backend: be, namespace: "pp:1337:0:", key: await importStorageKey(key32(1)) });
    const secret = JSON.stringify({ userSecrets: "nullifier=12345678901234567890" });
    await s.set("state", secret);
    expect(await s.get("state")).toBe(secret);
    expect(await s.get("missing")).toBeNull();
    const stored = [...be.dump().entries()];
    expect(stored.map(([k]) => k)).toEqual(["pp:1337:0:state"]);
    expect(stored[0]![1]).toMatch(/^v1:/);
    expect(stored[0]![1]).not.toContain("nullifier");
    // A fresh IV per write: the same plaintext encrypts differently.
    await s.set("state", secret);
    expect(be.dump().get("pp:1337:0:state")).not.toBe(stored[0]![1]);
  });

  it("fails closed on tampering, key swaps across names/namespaces, and a wrong key", async () => {
    const be = memoryBackend();
    const k = await importStorageKey(key32(2));
    const s = new EncryptedStorage({ backend: be, namespace: "pp:1:0:", key: k });
    await s.set("a", "alpha");
    await s.set("b", "beta");
    const a = be.dump().get("pp:1:0:a")!;
    // Copy a's ciphertext under b: AAD binds the full key, so it does not read as b.
    await be.set("pp:1:0:b", a);
    await expect(s.get("b")).rejects.toBeInstanceOf(StorageIntegrityError);
    // Another namespace with the same key cannot read it either.
    await be.set("pp:1:1:a", a);
    const other = new EncryptedStorage({ backend: be, namespace: "pp:1:1:", key: k });
    await expect(other.get("a")).rejects.toBeInstanceOf(StorageIntegrityError);
    // Bit flip in the ciphertext.
    const bytes = atob(a.slice(3));
    const flipped = "v1:" + btoa(bytes.slice(0, -1) + String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 1));
    await be.set("pp:1:0:a", flipped);
    await expect(s.get("a")).rejects.toBeInstanceOf(StorageIntegrityError);
    // Wrong key.
    await be.set("pp:1:0:a", a);
    const wrong = new EncryptedStorage({ backend: be, namespace: "pp:1:0:", key: await importStorageKey(key32(3)) });
    await expect(wrong.get("a")).rejects.toBeInstanceOf(StorageIntegrityError);
    await be.set("pp:1:0:a", "garbage");
    await expect(s.get("a")).rejects.toBeInstanceOf(StorageIntegrityError);
  });

  it("is unusable while locked (the key is released by a vault approval)", async () => {
    const s = new EncryptedStorage({ backend: memoryBackend(), namespace: "pp:" });
    expect(s.locked).toBe(true);
    await expect(s.get("x")).rejects.toBeInstanceOf(StorageLockedError);
    await expect(s.set("x", "y")).rejects.toBeInstanceOf(StorageLockedError);
    s.unlock(await importStorageKey(key32(4)));
    await s.set("x", "y");
    s.lock();
    await expect(s.get("x")).rejects.toBeInstanceOf(StorageLockedError);
  });

  it("works over a chrome.storage-shaped backend", async () => {
    const area = new Map<string, unknown>();
    const be = chromeStorageBackend({
      get: async (k) => (area.has(k) ? { [k]: area.get(k) } : {}),
      set: async (items) => void Object.entries(items).forEach(([k, v]) => area.set(k, v)),
      remove: async (k) => void area.delete(k),
    });
    const s = new EncryptedStorage({ backend: be, namespace: "pp:", key: await importStorageKey(key32(5)) });
    await s.set("k", "v");
    expect(await s.get("k")).toBe("v");
    await s.remove("k");
    expect(await s.get("k")).toBeNull();
  });
});

describe("Anon-RPC network", () => {
  it("sets the isolation key on every request and a caller cannot replace it", async () => {
    const seen: AnonRequestInit[] = [];
    const audit = vi.fn();
    const net = anonNetwork({
      fetch: async (_u, init) => {
        seen.push(init!);
        return new Response("{}");
      },
      isolationKey: "acct-key",
      onRequest: audit,
    });
    await net.fetch("https://rpc.example/", { method: "POST" });
    await net.fetch("https://rpc.example/", { anonOptions: { isolationKey: "other" } } as AnonRequestInit);
    expect(seen.map((i) => i.anonOptions?.isolationKey)).toEqual(["acct-key", "acct-key"]);
    expect(seen[0]!.method).toBe("POST");
    expect(audit).toHaveBeenCalledWith({ url: "https://rpc.example/", isolationKey: "acct-key" });
    expect(() => anonNetwork({ fetch: async () => new Response(), isolationKey: "" })).toThrow();
  });

  it("isolation keys: one per (account, chain), fresh ones never repeat", () => {
    const a = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    expect(isolationKeyFor(a, 1n)).toBe(isolationKeyFor(a.toLowerCase() as Hex, 1n));
    expect(isolationKeyFor(a, 1n)).not.toBe(isolationKeyFor(a, 11155111n));
    expect(freshIsolationKey()).not.toBe(freshIsolationKey());
  });

  it("JSON-RPC over the anon network", async () => {
    const keys: (string | undefined)[] = [];
    const net = anonNetwork({
      fetch: async (_u, init) => {
        keys.push(init?.anonOptions?.isolationKey);
        const req = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0x539" }));
      },
      isolationKey: "k1",
    });
    expect(await networkTransport("https://rpc.example/", net).request("eth_chainId")).toBe("0x539");
    expect(keys).toEqual(["k1"]);
  });
});

describe("VaultKeystore (Host keystore)", () => {
  it("throws for every path, including Kohaku's default signer path, unless the vault delegated it", async () => {
    const ks = new VaultKeystore();
    await expect(ks.deriveAt("m/28784'/1'/0'")).rejects.toBeInstanceOf(KeystorePathNotAllowedError);
    await expect(ks.deriveAt("m/44'/60'/0'/0/0")).rejects.toBeInstanceOf(KeystorePathNotAllowedError);
    const k = ("0x" + "11".repeat(32)) as Hex;
    ks.delegate("m/28784'/2'/7'", async () => k);
    expect(await ks.deriveAt("m/28784'/2'/7'")).toBe(k);
    await expect(ks.deriveAt("m/28784'/2'/8'")).rejects.toBeInstanceOf(KeystorePathNotAllowedError);
    ks.revoke("m/28784'/2'/7'");
    await expect(ks.deriveAt("m/28784'/2'/7'")).rejects.toBeInstanceOf(KeystorePathNotAllowedError);
    expect(() => ks.delegate("not a path", async () => k)).toThrow();
  });
});

describe("Host provider", () => {
  const rpc = (tag: string) => {
    const calls: string[] = [];
    return {
      calls,
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        switch (method) {
          case "eth_chainId":
            return "0x539";
          case "eth_getBalance":
            return tag === "helios" ? "0x2" : "0x1";
          case "eth_call":
            return tag === "helios" ? "0xbeef" : "0xdead";
          case "eth_getLogs":
            return [{ address: "0x" + "11".repeat(20), topics: [], data: "0x", blockNumber: "0x5", logIndex: "0x1" }];
          default:
            return "0x0";
        }
      },
    };
  };

  it("routes the correctness reads through the Helios hook, never logs", async () => {
    const raw = rpc("raw");
    const helios = rpc("helios");
    const p = createHostProvider({ rpc: raw, verifiedReads: heliosVerifiedReads(helios) });
    expect(p.readsVerified).toBe(true);
    expect(await p.call({ to: ("0x" + "11".repeat(20)) as Hex, data: "0x" })).toBe("0xbeef");
    expect(await p.getBalance(("0x" + "11".repeat(20)) as Hex)).toBe(2n);
    const logs = await p.getLogs({ address: ("0x" + "11".repeat(20)) as Hex, fromBlock: 1n, toBlock: 9n });
    expect(logs[0]).toMatchObject({ blockNumber: 5n, logIndex: 1 });
    expect(helios.calls).toEqual(["eth_call", "eth_getBalance"]);
    expect(raw.calls).toEqual(["eth_getLogs"]);
  });

  it("without a light client, reads are flagged unverified", async () => {
    const raw = rpc("raw");
    const p = createHostProvider({ rpc: raw });
    expect(p.readsVerified).toBe(false);
    expect(await p.call({ to: ("0x" + "11".repeat(20)) as Hex, data: "0x" })).toBe("0xdead");
    expect(await p.getChainId()).toBe(1337n);
  });
});

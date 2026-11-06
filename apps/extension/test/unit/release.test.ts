import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

// The release scripts are plain .mjs (no build step on the release path); import them untyped.
const lib = (await import(String(new URL("../../../../scripts/release/lib.mjs", import.meta.url)))) as {
  deterministicZip(dir: string, mtime: number, files?: string[]): Buffer;
};
const rb = (await import(String(new URL("../../scripts/release-build.mjs", import.meta.url)))) as {
  releaseBuild(
    out: string,
  ): Promise<{ name: string; version: string; build: string; zipSha256: string; files: Record<string, string> }>;
  buildProduction(): Promise<{ tmp: string; dir: string }>;
};
const sp = (await import(String(new URL("../../scripts/store-package.mjs", import.meta.url)))) as {
  checkStorePackage(
    dir: string,
    o?: { acceptPermissionChange?: boolean; baseline?: string; listing?: string },
  ): { submission: { version: string; zipSha256: string; permissions: Record<string, string> } };
};
const rc = (await import(String(new URL("../../scripts/release-check.mjs", import.meta.url)))) as {
  checkProductionBuild(dir: string, files: Record<string, string>, o?: { root?: string }): unknown;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const tmps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** Minimal zip reader (central directory → entries), enough to check what the writer produced. */
function unzip(zip: Buffer): { name: string; data: Buffer; mode: number; extra: number }[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const mode = zip.readUInt32LE(p + 38) >>> 16;
    const off = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lname = zip.readUInt16LE(off + 26);
    const body = zip.subarray(off + 30 + lname + zip.readUInt16LE(off + 28), off + 30 + lname + csize);
    out.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body), mode, extra });
    p += 46 + nameLen + extra;
  }
  return out;
}

describe("deterministic zip (scripts/release/lib.mjs)", () => {
  it("same inputs → same bytes; sorted, fixed mode, no extra fields, round-trips", () => {
    const d = tmp("leaked-zip-");
    mkdirSync(join(d, "b"));
    writeFileSync(join(d, "b/x.js"), "x".repeat(1000));
    writeFileSync(join(d, "a.json"), "{}");
    const z1 = lib.deterministicZip(d, 1_700_000_000);
    const z2 = lib.deterministicZip(d, 1_700_000_000);
    expect(sha256(z1)).toBe(sha256(z2));
    expect(sha256(lib.deterministicZip(d, 1_700_000_100))).not.toBe(sha256(z1));
    const e = unzip(z1);
    expect(e.map((x) => x.name)).toEqual(["a.json", "b/x.js"]);
    expect(e.every((x) => x.mode === 0o100644 && x.extra === 0)).toBe(true);
    expect(e[1]!.data.toString()).toBe("x".repeat(1000));
  });
});

describe("production extension build (apps/extension/scripts/release-build.mjs)", () => {
  it("is a clean store build: the zip is the unpacked tree, no gallery, no devnet paths", async () => {
    const out = tmp("leaked-ext-rel-");
    const m = await rb.releaseBuild(out);
    expect(m.name).toBe("leaked-extension");
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/u);
    const zip = readFileSync(join(out, `leaked-extension-${m.version}-chrome.zip`));
    expect(sha256(zip)).toBe(m.zipSha256);
    const entries = unzip(zip);
    expect(Object.fromEntries(entries.map((x) => [x.name, sha256(x.data)]))).toEqual(m.files);
    const text = entries
      .filter((x) => /\.(js|html|json|css)$/u.test(x.name))
      .map((x) => x.data.toString("utf8"))
      .join("\n");
    // Spelled out here as well as in release-check.mjs, so weakening the checker alone cannot pass this test.
    expect(text).not.toContain("0x1234567890abcdef1234567890abcdef1234abcd"); // design gallery demo address
    expect(text).not.toMatch(/localhost:(8545|8546|4337|14337|14340)/u);
    expect(text).not.toContain("Local devnet");
    expect(text).not.toContain("__leakedPq");
    expect(entries.some((x) => x.name.endsWith(".map"))).toBe(false);
    const mf = JSON.parse(entries.find((x) => x.name === "manifest.json")!.data.toString()) as {
      host_permissions: string[];
      permissions: string[];
    };
    expect(mf.host_permissions.some((h) => h.includes("localhost"))).toBe(false);
    expect(mf.permissions).toEqual(["storage", "alarms", "offscreen", "notifications"]);
  }, 120_000);

  it("the checker refuses a local-devnet + design build (the markers are real)", async () => {
    const saved = { ...process.env };
    process.env.VITE_LEAKED_LOCAL_DEVNET = "1";
    process.env.VITE_LEAKED_DESIGN = "1";
    const outDir = tmp("leaked-ext-dev-");
    try {
      const { build } = await import("wxt");
      await build({
        root: String(new URL("../..", import.meta.url).pathname),
        outDir,
        mode: "production",
      });
    } finally {
      process.env = saved;
    }
    const { walk } = (await import(String(new URL("../../../../scripts/release/lib.mjs", import.meta.url)))) as {
      walk(d: string): string[];
    };
    const built = { dir: join(outDir, "chrome-mv3") };
    const files = Object.fromEntries(walk(built.dir).map((f) => [f, ""]));
    let msg = "";
    try {
      rc.checkProductionBuild(built.dir, files);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const what of ["design gallery", "local devnet RPC", "local devnet network", "e2e probe", "host_permissions"])
      expect(msg).toContain(what);
  }, 120_000);

  it("store package: passes on the release, refuses a permission change and a missing justification", async () => {
    const out = tmp("leaked-ext-store-");
    const m = await rb.releaseBuild(out);
    const { submission } = sp.checkStorePackage(out);
    expect(submission.zipSha256).toBe(m.zipSha256);
    expect(Object.keys(submission.permissions)).toContain("notifications");
    const base = join(out, "base.json");
    writeFileSync(
      base,
      JSON.stringify({ permissions: ["storage"], host_permissions: [], optional_host_permissions: [] }),
    );
    expect(() => sp.checkStorePackage(out, { baseline: base })).toThrow(/permissions changed since the last release/u);
    expect(() => sp.checkStorePackage(out, { baseline: base, acceptPermissionChange: true })).not.toThrow();
    const listing = join(out, "listing.md");
    writeFileSync(listing, "## Short description\n\nx\n\n## Permission justifications\n\n| `storage` | x |\n");
    expect(() => sp.checkStorePackage(out, { listing })).toThrow(/no justification for `alarms`/u);
    writeFileSync(join(out, `leaked-extension-${m.version}-chrome.zip`), "tampered");
    expect(() => sp.checkStorePackage(out)).toThrow();
  }, 120_000);

  it("refuses to build with the devnet flags set", async () => {
    process.env.VITE_LEAKED_LOCAL_DEVNET = "1";
    try {
      await expect(rb.buildProduction()).rejects.toThrow(/VITE_LEAKED_LOCAL_DEVNET is set/u);
    } finally {
      delete process.env.VITE_LEAKED_LOCAL_DEVNET;
    }
  });
});

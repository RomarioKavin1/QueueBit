import { describe, expect, it } from "vitest";
import { PermissionsStore, normalizeOrigin } from "../../src/background/permissions";
import { MemoryKV } from "../../src/shared/kv";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("PermissionsStore", () => {
  it("grants, lists and revokes per origin", async () => {
    let t = 1;
    const p = new PermissionsStore(new MemoryKV(), () => t++);
    expect(await p.isPermitted("https://app.example")).toBe(false);
    await p.grant("https://app.example", [A]);
    await p.grant("http://localhost:5173", [A]);
    expect(await p.isPermitted("https://app.example")).toBe(true);
    expect(await p.isPermitted("https://evil.example")).toBe(false);
    expect((await p.list()).map((x) => x.origin)).toEqual(["http://localhost:5173", "https://app.example"]);
    expect(await p.revoke("https://app.example")).toBe(true);
    expect(await p.revoke("https://app.example")).toBe(false);
    expect(await p.isPermitted("https://app.example")).toBe(false);
    expect(await p.isPermitted("http://localhost:5173")).toBe(true);
  });

  it("keeps the first grant time when re-granted", async () => {
    let t = 10;
    const p = new PermissionsStore(new MemoryKV(), () => t++);
    const first = await p.grant("https://app.example", [A]);
    const again = await p.grant("https://app.example", [A]);
    expect(again.grantedAt).toBe(first.grantedAt);
  });

  it("tracks known sites for first-visit warnings, surviving a revoke", async () => {
    const p = new PermissionsStore(new MemoryKV(), () => 5);
    expect(await p.isFirstVisit("https://app.example")).toBe(true);
    await p.grant("https://app.example", [A]);
    expect(await p.isFirstVisit("https://app.example")).toBe(false);
    await p.revoke("https://app.example");
    expect(await p.isFirstVisit("https://app.example")).toBe(false);
    expect(await p.knownSite("https://app.example")).toMatchObject({ firstSeenAt: 5 });
  });

  it("treats origins case-insensitively but not across schemes or ports", async () => {
    const p = new PermissionsStore(new MemoryKV());
    await p.grant("https://App.Example", [A]);
    expect(await p.isPermitted("https://app.example")).toBe(true);
    expect(await p.isPermitted("http://app.example")).toBe(false);
    expect(await p.isPermitted("https://app.example:8443")).toBe(false);
  });

  it.each([
    "not a url",
    "https://a.example/path",
    "https://a.example/?q=1",
    "chrome-extension://abc",
    "https://u:p@a.example",
  ])("rejects non-origin %s", (o) => {
    expect(() => normalizeOrigin(o)).toThrow();
  });
});

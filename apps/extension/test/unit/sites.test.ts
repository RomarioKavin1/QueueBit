import { describe, expect, it } from "vitest";
import { ALLOWED_LICENSES, SITE_LISTS, siteWarning } from "../../src/shared/sites";

describe("known-bad site lists (docs/release/phishing-list.md)", () => {
  it("bundles only permissively licensed lists (no DBAD eth-phishing-detect, no unlicensed data)", () => {
    expect(SITE_LISTS.length).toBeGreaterThan(0);
    for (const l of SITE_LISTS) {
      expect(ALLOWED_LICENSES as readonly string[]).toContain(l.license);
      expect(l.license).not.toMatch(/DBAD|GPL|unknown|UNLICENSED/iu);
      expect(l.id).not.toMatch(/eth-phishing-detect|metamask/iu);
    }
  });

  it("entries are lowercase hostnames without duplicates", () => {
    const all = SITE_LISTS.flatMap((l) => l.hosts);
    expect(new Set(all).size).toBe(all.length);
    for (const h of all) expect(h).toMatch(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/u);
  });

  it("warns on a listed host and its subdomains, any port or scheme; not on lookalike suffixes", () => {
    expect(siteWarning("https://leaked-phishing-test.invalid")).toMatchObject({ kind: "listed" });
    expect(siteWarning("http://app.leaked-phishing-test.invalid:8080")).toMatchObject({
      kind: "listed",
      host: "app.leaked-phishing-test.invalid",
    });
    expect(siteWarning("https://notleaked-phishing-test.invalid")).toBeNull();
    expect(siteWarning("https://app.uniswap.org")).toBeNull();
    expect(siteWarning("not a url")).toBeNull();
  });

  it("flags punycode (lookalike) hosts", () => {
    expect(siteWarning("https://xn--unswap-qvf.org")).toEqual({ kind: "lookalike", host: "xn--unswap-qvf.org" });
    expect(siteWarning("https://unіswap.org")).toMatchObject({ kind: "lookalike" }); // Cyrillic і
  });

  it("accepts another list for checks", () => {
    const lists = [{ id: "x", name: "X", license: "CC0-1.0", hosts: ["bad.example"] }];
    expect(siteWarning("https://a.bad.example", lists)).toEqual({ kind: "listed", host: "a.bad.example", list: "X" });
  });
});

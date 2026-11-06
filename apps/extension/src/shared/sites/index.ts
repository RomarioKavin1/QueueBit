import { LEAKED_LIST } from "./leaked-list";

/**
 * Known-bad sites (plan §30 §9 item 2; policy in docs/release/phishing-list.md). Lists are bundled data, updated
 * only with an extension release (no remote list, no remote code). A list may be bundled only under a license from
 * `ALLOWED_LICENSES`: `eth-phishing-detect` (DBAD) and lists without a clear license are excluded.
 */
export interface SiteList {
  id: string;
  name: string;
  /** SPDX identifier of the list's data license. */
  license: string;
  hosts: string[];
}

export const ALLOWED_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "0BSD",
] as const;

export const SITE_LISTS: readonly SiteList[] = [LEAKED_LIST];

export type SiteWarning =
  | { kind: "listed"; host: string; list: string }
  /** An internationalised (punycode) host: it may imitate another site's name with lookalike letters. */
  | { kind: "lookalike"; host: string };

function index(lists: readonly SiteList[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lists) for (const h of l.hosts) m.set(h.toLowerCase(), l.name);
  return m;
}
const INDEX = index(SITE_LISTS);

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return null;
  }
};

/** The warning for `origin` (listed host or a parent domain of it; else a punycode host), or null. Warn, never block. */
export function siteWarning(origin: string, lists: readonly SiteList[] = SITE_LISTS): SiteWarning | null {
  const host = hostOf(origin);
  if (!host) return null;
  const idx = lists === SITE_LISTS ? INDEX : index(lists);
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const list = idx.get(labels.slice(i).join("."));
    if (list) return { kind: "listed", host, list };
  }
  if (labels.some((l) => l.startsWith("xn--"))) return { kind: "lookalike", host };
  return null;
}

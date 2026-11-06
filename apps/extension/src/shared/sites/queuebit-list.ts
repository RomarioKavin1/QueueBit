import type { SiteList } from "./index";

/**
 * QueueBit's own known-bad host list (MIT, this repository). A listed host also covers its subdomains. Entries are
 * added only from incidents reported through SECURITY.md and confirmed by a maintainer, never copied from a list
 * whose license is outside `ALLOWED_LICENSES` (docs/release/phishing-list.md). `.invalid` hosts are reserved test
 * fixtures (RFC 6761: they never resolve). Updated 2026-11-06.
 */
export const QUEUEBIT_LIST: SiteList = {
  id: "queuebit",
  name: "QueueBit's list of known scam sites",
  license: "MIT",
  hosts: ["queuebit-phishing-test.invalid"],
};

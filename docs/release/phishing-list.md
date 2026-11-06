# Known-sites and scam-site list policy

Plan [`30-extension.md` §9 item 2](../plan/sections/30-extension.md). Code: `apps/extension/src/shared/sites/`
(the lists and `siteWarning`), shown on every approval window (`siteWarning` in `ApprovalView`); test
`apps/extension/test/unit/sites.test.ts`.

1. **Only permissively licensed lists, or ours.** A list's data is bundled only under one of `ALLOWED_LICENSES`
   (MIT, Apache-2.0, BSD-2/3-Clause, ISC, CC0-1.0, 0BSD), recorded per list as an SPDX id and checked by the test.
   Excluded: `eth-phishing-detect` / MetaMask's list (DBAD, not an OSI license), Ambire's `suspiciousHostingDomains.ts`
   (GPL-3.0; reference only, nothing copied), and any list without a clear data license. Adding a third-party list
   needs its license recorded here and a counsel check (release checklist §4).
2. **Our list** (`leaked-list.ts`, MIT): hosts added from incidents reported through [`SECURITY.md`](../../SECURITY.md)
   and confirmed by a maintainer, in a reviewed commit. A host covers its subdomains. `.invalid` hosts are test fixtures.
3. **Bundled, never remote.** Lists change only with an extension release (reproducible, hashed); the extension
   fetches no list at run time, so it leaks no browsing history to a list server.
4. **Warn, never block silently.** A listed site (or the page embedding it) gets a red banner on the approval window;
   a punycode (internationalised) host gets a lookalike warning. The user can still decide; nothing is hidden.
5. **Known sites** (first-visit warnings) are local only: `leaked:knownSites`, the sites this browser connected to,
   never shared or synced.

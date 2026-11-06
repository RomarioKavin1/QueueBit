# Release checklist

Gate G4 of the plan ([`LEAKED-implementation-plan.md` §5.2](../plan/LEAKED-implementation-plan.md)): audits closed;
the 4337 backend released to mainnet; the frame-native backend on Hegotá testnets, waiting for the fork. Nothing
reaches a store, a host or a mainnet address until every box that applies to the release is ticked, **with a link to
the evidence** (a commit, a report, a written confirmation). A box that does not apply says why.

Status on 2026-11-06: **none of the release gates below is met.** LEAKED is pre-audit, devnet and anvil only.

## 1. Code and build

- [ ] `main` is green on `ci` (typecheck, lint, unit tests, both e2e suites, the 4337 anvil e2e, contracts with the
      `ci` profile, `lint-verify.sh`, the WASM reproducibility jobs, `release-reproducible`).
- [ ] The latest nightly `devnet` run is green (gate G1, the extension e2e against the devnet, the watcher and rpc
      live tests), and its `last-run.json` is attached to the release notes.
- [ ] `node scripts/release/verify-reproducible.mjs` passes with `REQUIRE_ALL=1` (both the companion and the
      extension zip, [`scripts/release/README.md`](../../scripts/release/README.md); passes locally since `f94e135`,
      needs the CI run on the tag).
- [ ] Two maintainers build the release independently from the tag and get the same `SHA256SUMS` as the `release`
      workflow. The hashes are committed (or published in the release notes) **before** the store upload.
- [ ] The extension zip is built without the local-devnet flags (enforced: `release-build.mjs` refuses them and
      `release-check.mjs` refuses devnet/gallery markers), and `apps/extension/scripts/store-package.mjs` passes: its
      `manifest.json` permissions match the previous release (`apps/extension/store/permissions.json`), or every new
      permission has a changelog line (plan §30 §9 item 7), and each has a justification in
      [`store-listing.md`](store-listing.md). Store screenshots at 1280×800 and the privacy policy URL are in place.
- [ ] `docs/plan/BACKLOG.md` has no open item tagged as blocking this release.

## 2. Audits

- [ ] Contracts: account (`contracts/src/account`), role signers and guardian (`contracts/src/roles`), the 7579
      modules (`contracts/src/modules`), `PoolPayer` (`contracts/src/privacy`). Audit scope: plan §10.8.
- [ ] Cryptanalysis review of the PQ scheme and its implementations: the vendored SPHINCS- C13 verifier, the Rust
      signer (`packages/pq-signer/rust`), and leanSphincs-s if it ships (it has no formal proof; it is experimental).
- [ ] Extension and companion (key handling, the QR protocol, the clear-signing registry, CSP, the update path).
- [ ] `@leaked/groth16` (our zkey reader, QAP reduction and witness glue). The circuits themselves are 0xbow's and
      are not audited by us.
- [ ] Every finding is fixed or accepted in writing, with a regression test; `docs/security/THREAT-MODEL.md` is
      updated to match; the audit reports are linked from `SECURITY.md`.

## 3. Supply chain

- [ ] The `supply-chain` workflow's latest run: `pnpm audit --prod` and `cargo audit` findings triaged (known on
      2026-11-06: `RUSTSEC-2024-0388`, `derivative` unmaintained, a transitive arkworks dependency of
      `packages/groth16/rust`; informational, no vulnerability).
- [ ] The CycloneDX SBOMs from that run (`sbom-cyclonedx` artifact) are attached to the release.
- [ ] `pnpm-workspace.yaml` still has an empty `onlyBuiltDependencies` with `strictDepBuilds: true`, or every entry
      has a review note.
- [ ] Every GitHub Action is pinned by commit SHA; the devnet images are pinned by digest (`devnet.yml`).

## 4. Licenses and legal

- [ ] **The circom artifact.** `withdraw.wasm` (the Privacy Pools withdrawal circuit, compiled by circom) embeds
      circom's field-arithmetic runtime, and circom is GPL-3.0. Whether that reaches the generated artifact depends on
      the artifact's license and on circom's position on generated code. Get a written opinion from counsel, or a
      written license statement from 0xbow, before any store release that bundles it
      ([`IMPLEMENTATION-NOTES.md`](../plan/IMPLEMENTATION-NOTES.md), "license exceptions for `@leaked/groth16`").
- [ ] Kohaku: written license terms from the maintainers before shipping anything that bundles `@kohaku-eth/*`
      (plan §1 item 15). Today nothing does; re-check that the lockfile still has no `@kohaku-eth/*`.
- [ ] Phishing list data license (plan §30 §9 item 2): only permissively licensed lists or ours are bundled
      ([`phishing-list.md`](phishing-list.md); today only LEAKED's own MIT list); `eth-phishing-detect` (DBAD) is
      excluded. Confirm with counsel before any third-party list is added.
- [ ] Accepted non-MIT/Apache licenses are still only `subtle` (BSD-3-Clause) and `foldhash` (Zlib) in the WASM
      (check the cargo SBOMs), and `THIRD_PARTY.md` lists every copied file.
- [ ] Privacy rules of plan §40.7: no operated pool, no fees, PoolPayer at cost and handed off. Not legal advice:
      counsel signs off on the privacy features for each jurisdiction the store listing targets.

## 5. Upstream dependencies

- [ ] **BUDGET-010** (per-entity verification gas budgets in the ERC-8421 sidecar): status of the upstream PR
      (`upstream/skandha-budget-010/PR.md`; not opened yet, it needs the maintainer's GitHub account). If it has not
      landed, Path A and PoolPayer run only on our own staked sidecar, the release notes say so, and Path B stays the
      default for the Vault.
- [ ] EIP-8141 and ERC-8421 text versus the pinned codec profile (`@leaked/frames` profiles, plan §10.8 spec drift):
      no unreviewed change since the audit.
- [ ] 0xbow: ASP root history and the custom `processooor` path confirmed for the target chain.

## 6. Mainnet gating

- [ ] **The frame-native backend does not ship to mainnet before Hegotá activates there.** Until then it is
      enabled only on Hegotá devnets and testnets, and the mainnet build has no frame-native network in its list.
      After the fork: re-run gate G1 on a public Hegotá testnet with the mainnet build, then on mainnet with small
      funds.
- [ ] **4337 mainnet addresses.** EntryPoint v0.8 is the canonical `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`
      (verify its code hash on the chain). The LEAKED modules (`LeakedHotValidator`, `LeakedPolicyHook`,
      `LeakedRoleExecutor`), `C13Verifier`, the MSA v0.8 shim and `MSAFactory` are deployed by CREATE2 from the
      audited commit; each address, init-code hash and the audit commit are recorded in the repo and checked by the
      extension's drift test. Sepolia and mainnet stay disabled in the extension until that record exists
      (`BACKLOG.md`, extension M2 follow-ups). A public bundler's pricing of the 4.2 KB Vault calldata is measured.
- [ ] PoolPayer: `MIN_SETTLE_GAS` / `MAX_INTRINSIC_GAS` calibrated on a mainnet-like chain; stake budgeted
      (~USD 1,000 per staked entity under the current ERC-8421 draft).

## 7. Key ceremonies

Each ceremony has two people present, a written log (date, participants, hardware, software commit and hashes,
resulting public keys or addresses), and the log is committed without any secret.

- [ ] **Store and hosting accounts.** Chrome Web Store publisher account and the companion's host (DNS, TLS, the
      static site): hardware security keys for every member, no SMS recovery, at least two owners.
- [ ] **Release tag signing.** Tags are signed; the signing keys' fingerprints are in `SECURITY.md`.
- [ ] **PoolPayer operator.** Generated offline; the two-step `setOperator` hand-off to the at-cost operator is
      rehearsed on a testnet first (plan §40, risk 5).
- [ ] **Staking.** The keys that fund stakes for our sidecar entities (role signers on our lane, PoolPayer), with the
      1-day unstake delay rehearsed.
- [ ] **Deployments.** Deployments are CREATE2 with no owner or admin key on the factories; confirm the deployer key
      holds no role afterwards, and record the deployment transactions.
- [ ] **Security contact key** (`SECURITY.md`): the PGP or age key for encrypted reports, held by two maintainers.

## 8. Communication

- [ ] Release notes: what changed, every new permission, the `SHA256SUMS`, the companion `swVersion`, known gaps
      (copied from THREAT-MODEL §11), and "unaudited" where it still applies.
- [ ] `README.md` "Security status" matches the release.

# Security policy

## Status: unaudited

QueueBit has had **no external audit** of any component: contracts, the post-quantum signer and verifier, the browser
extension, the LeanPool node, the Groth16 engine or the watcher. It runs on devnets only. Do not use
it with funds you are not prepared to lose. The threat model, including what is known to be missing, is
[`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md) (§10 lists the open gaps).

## Reporting a vulnerability

Please report privately; do not open a public issue or pull request for a security problem.

- Use GitHub's **private vulnerability reporting** on this repository (Security tab, "Report a vulnerability").
- If that is unavailable, contact the maintainers privately and ask for an encrypted channel before sending details.

Include: the component and commit, what an attacker needs (which keys, which position: dapp, network, co-installed
extension, physical access to the phone), the impact, and a proof of concept if you have one (a Foundry test or a
script against the local devnet is ideal: `devnet/README.md`).

What to expect:

| | |
|---|---|
| Acknowledgement | within 3 working days |
| First assessment (severity, scope) | within 10 working days |
| Fix or mitigation plan | agreed with you; we aim for 90 days at most before public disclosure |
| Credit | in the advisory and release notes, unless you prefer otherwise |

We follow coordinated disclosure. There is no bug bounty yet.

## Scope

In scope:

- `contracts/src/**`: LeanAccount, the keystore, the hook, guardian recovery, the factory, DepsRegistry, PoolPayer.
  Especially anything that lets a **session key** exceed its on-chain bounds (THREAT-MODEL §4), lets anyone but the
  owner (or guardians, after the delay) change keys or policy, or makes VERIFY-frame code inadmissible or griefable.
- `packages/account`: anything that makes the SDK build or sign a different tx than the user approved.
- `services/leanpool-node`: accepting a dependency whose signature does not verify, or posting a root for one.
- `packages/pq-signer` (signing, key generation, the C13 and leanSphincs-s implementations) and the vendored
  verifiers' integration (`C13Verifier`, the adapters).
- `packages/frames`, `packages/ur`, `packages/rpc`: codec and signature-hash errors.
- `apps/extension`: key storage, origin attribution, policy pre-checks that are looser than the chain, the approval
  windows.
- `packages/groth16`, `packages/privacy`: bogus proofs, note-secret derivation, linkability through the RPC path.
- `services/watcher`, `packages/watcher-core`: alert suppression or forgery.
- The release tooling (`scripts/release`) and CI (`.github/workflows`): anything that would let a build differ from
  the source.

Out of scope:

- The dev keys in `devnet/README.md` and test fixtures (they are public on purpose).
- Third-party code we pin (submodules in `contracts/lib/`, npm and crates dependencies, the upstream sidecar, the
  ethrex devnet images), unless our integration of it is the problem. Report upstream issues upstream; tell us if we
  are affected.
- Known gaps listed in THREAT-MODEL §10 and `docs/plan/BACKLOG.md` (reports that show they are worse than described
  are welcome).
- The design limits stated in the threat model (for example: the owner key's approvals trust its LeanPool aggregator;
  a session key can burn the account's ETH on fees; an EIP-7702-migrated EOA's ECDSA key keeps working).

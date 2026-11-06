# Security policy

## Status: unaudited

QueueBit has had **no external audit** of any component: contracts, the post-quantum signer and verifier, the browser
extension, the vault companion, the Groth16 engine or the watcher. It runs on local devnets and anvil only. Do not use
it with funds you are not prepared to lose. The threat model, including what is known to be missing, is
[`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md) (§11 lists the open gaps).

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

- `contracts/src/**`: the frame-native account, role signers, guardian, the ERC-7579 modules, PoolPayer. Especially
  anything that lets a leaked **hot key** exceed its on-chain bound (THREAT-MODEL §3), bypasses a timelock, lets anyone
  but the Vault or Recovery change policy, or makes VERIFY-frame code inadmissible or griefable.
- `packages/pq-signer` (signing, key generation, the C13 and leanSphincs-s implementations) and the vendored
  verifiers' integration (`C13Verifier`, the adapters).
- `packages/frames`, `packages/ur`, `packages/rpc`: codec and signature-hash errors, UR decoding (anything that makes
  the phone display one thing and sign another).
- `apps/companion`: key storage, the signing worker, the no-network guarantee, the update path.
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
- Known gaps listed in THREAT-MODEL §11 and `docs/plan/BACKLOG.md` (reports that show they are worse than described
  are welcome).
- The design limits stated in the threat model (for example: a leaked hot key can spend the remaining daily cap; a
  compromised Recovery key can take over the Vault after 7 days).

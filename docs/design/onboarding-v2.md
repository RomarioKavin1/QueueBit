# Onboarding v2: "working in 60 seconds, secured over the first week"

## Problem (user test, 2026-11-06)
Onboarding v1 has ~9 mandatory steps: everyday key, password, vault pairing, recovery ceremony, guardian, limit, network, tokens, faucet and activation. It also needs the **laptop webcam** to read a QR code from the phone. Users get lost.

## Principles
1. **Only one thing is mandatory: connect your phone.** Everything else has a safe default or happens later.
2. **The phone camera is the only camera.** Phones scan screens easily; laptop webcams don't. Data going phone → browser uses a relay, never the laptop camera.
3. **Progressive security.** After setup, a "Secure your wallet" checklist on Home asks for the remaining steps (recovery key, backup) with plain reasons and progress.
4. **Never more than one decision per screen.** Defaults are pre-filled and editable later in Settings.

## New flow (3 screens)
1. **Welcome:** "Create wallet" (or "I already have one"). Set a password. The everyday key and fee tank are generated silently. Seed backup is deferred to the checklist, which has a persistent reminder until done.
2. **Connect your phone:** the browser shows ONE QR code (a link: `<companion-url>/#pair=<sessionId>.<sessionKey>`).
   - The user scans it with the phone's normal camera app. The companion opens straight into "Link to browser": create a Vault key (words + passphrase) or use the existing one.
   - The phone sends its pairing code (pk, payer address, fingerprint) to the browser through the **relay**. The browser shows "Connected ✓" plus the same 4-word fingerprint on both screens to confirm.
   - The fallback stays available: "Can't scan? Use the manual code" (the current paste flow).
3. **Ready:** defaults are applied: limit $50/day, Open recipient mode, network chosen by the build, preset tokens. On devnets the account is auto-funded from the faucet and auto-activated with one button ("Finish setup"). Then Home opens with the checklist.

## Vault approvals with the relay
- The browser shows the animated request QR. The **phone** scans it, the user approves, and the phone sends the signature back through the relay. The browser verifies it (as today) and submits. **No laptop camera, no "scan back".**
- Air-gapped mode (Settings → Vault → "Offline phone (no relay)") keeps today's two-way QR/paste flow.

## The relay (devnet: on the shared server, inside ~/queuebit-devnet)
- A tiny HTTP service with one-time channels: `PUT /relay/<sessionId>` (phone) and `GET /relay/<sessionId>?wait=25` (browser, long-poll). Messages are capped at 16 KB and expire after 5 minutes. It has no accounts and stores nothing durably.
- **End-to-end encrypted:** payloads are AES-GCM encrypted with the `sessionKey` from the QR fragment. The fragment never reaches the server, so the relay can't read or alter messages.
- **What travels:** only public data (pk, payer address, signatures, recovery-test answers). The browser re-verifies everything cryptographically, as it does now.
- **Companion CSP:** `connect-src` allows only the configured relay origin (it was `'none'`). The trade-off is documented in THREAT-MODEL.md: a compromised companion build could now exfiltrate over the relay. The mitigations are verified updates, the relay origin pinned at build time, and the offline mode for high-value users.

## Secure-your-wallet checklist (Home)
- [ ] Back up your everyday words (≈1 min)
- [ ] Add a Recovery key (≈2 min, on a second device, or a second profile on the same phone for a test)
- [ ] (optional) Add a Guardian
- [ ] (optional) Adjust your daily limit

Each item shows why it matters in one line. Completing all of them shows "Fully secured ✓".

## Acceptance
- A new user reaches a funded, active wallet in **≤ 3 screens and ≤ 60 s** (excluding writing down words), with no laptop camera.
- Playwright e2e covers the full v2 flow with the simulated phone over the relay. The air-gapped flow still passes.
- Security review of the relay + CSP change.

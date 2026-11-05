# 30. The browser extension

Section of the LEAKED v4 implementation plan. Binding input: `../00-v4-design-decisions.md`. Companion sections (contracts, PQ crypto/vault, privacy/infra) are written in parallel; where this section depends on them, the interface is listed in §12.

**Verification legend.** `[VERIFIED]` = read in a cloned repo (path:line below) or probed read-only on a public endpoint on 2026-11-06. `[SPEC-DRAFT]` = read in a Draft EIP/ERC text; the value may change. `[UNVERIFIED]` = not confirmed; a verification step is given. Repo clones live under `/private/tmp/claude-501/-Users-romariokavin-Documents-RandomClaudeSessions/d426a882-c55f-4a32-9511-c5a43a5de11d/scratchpad/repos/` (called `repos/` below).

Evidence base used throughout:

| Source | Where | Commit / version |
|---|---|---|
| EIP-8141 text (current) | `repos/eips/EIPS/eip-8141.md` | ethereum/EIPs af5ea76 (2026-11-05) |
| ERC-8421 rules as implemented by the sidecar | `repos/mempool-workshop-documentation/src/content/docs/rules/*.md`, `reference/rpc-methods.md` | forshtat/mempool-workshop-documentation 28aef28 |
| Alt-mempool sidecar (skandha fork) | `repos/mempool-workshop-sidecar/packages/{api,types,executor}` | forshtat/mempool-workshop-sidecar 2e22ff0 |
| Frame-tx TS library the prototype used | `repos/hegota-support/src/{tx,rpc,profiles}` (npm `@forshtat/hegota-support@0.0.1`, MIT) | forshtat/hegota-support 2377188 |
| Workshop glue (`send.ts`, `build.ts`) | `repos/mempool-workshop/src/lib/frameTx/*` | forshtat/mempool-workshop bcfe02a |
| Kohaku reference wallet (Ambire fork) | `repos/kohaku-extension` (GPL-3.0) + `repos/ambire-common` | ethereum/kohaku-extension 72922ab; AmbireTech/ambire-common ab6337f (v2.115.1) |
| Kohaku SDK | `repos/kohaku` | ethereum/kohaku 39ba1bd |
| Anon-RPC | `repos/anon-rpc` (MIT) | ethereum/anon-rpc c8980fb (spec 0.4.0) |
| Public devnet endpoints | `https://altmempool.forshtat.com` (ethrex), `https://altmempool.forshtat.com/rpc` and `https://altmempoolgateway.forshtat.com/rpc` (sidecar) | probed 2026-11-06: `web3_clientVersion` = `ethrex/v23.0.0-eip8141-tracer-9aa3645d…` and `skandha/v4.1.1-`; `eth_chainId` = `0x539` (1337) |

---

## 1. Base decision: fork Kohaku/Ambire or build from scratch

### 1.1 What the Kohaku/Ambire extension actually is `[VERIFIED]`

| Property | Finding | Evidence |
|---|---|---|
| Repo, license | `ethereum/kohaku-extension`, GPL-3.0; it is "a fork of Ambire Wallet (AmbireTech/extension)", GPL-3.0 | `repos/kohaku-extension/README.MD:10`, `LICENSE:1`; GitHub API: `AmbireTech/extension license=GPL-3.0`, `ethereum/kohaku-extension GPL-3.0` |
| Framework | React Native 0.70.5 + Expo 47 + React 18.3.0, built for the web with webpack; `ambire-mobile-wallet` is the package name | `repos/kohaku-extension/package.json` (`"react-native": "0.70.5"`, `"expo": "^47.0.0"`, `"react": "18.3.0"`), `webpack.config.js:346-359` (entries `main`, `background`, `content-script`, `ambire-inpage`, `ethereum-inpage`, plus two Gecko-only injection scripts) |
| Chain libs | ethers 6.13.4 in the extension; `ambire-common` 2.115.1 depends on ethers ^6.8.0 **and** viem 2.56.3 | `kohaku-extension/package.json`, `ambire-common/package.json` |
| Size | 125,689 lines of `.ts/.tsx` in the extension (excluding `node_modules` and the uninitialised submodule) + ~113,000 lines in `ambire-common/src` (excluding tests); 212 test files in ambire-common, 11 in the extension | `find … | xargs wc -l` on both clones (re-counted 2026-11-06) |
| Account model | Ambire's own `AmbireAccount.sol` / `AmbireAccount7702.sol` + `AmbireFactory.sol`; **not ERC-7579** (no `installModule` anywhere in `ambire-common/src`; the only "7579" hits are humanizer metadata) | `repos/ambire-common/contracts/`, grep over `ambire-common/src` |
| 4337 | Bundler abstraction with Pimlico/Etherspot/Gelato drivers (`eth_estimateUserOperationGas` `bundler.ts:68,73`, `eth_getUserOperationReceipt` `bundler.ts:124`, `etherspot.ts:44`, `gelato.ts:102`; `pimlico_getUserOperationGasPrice` in `pimlico.ts:42,46`) | `ambire-common/src/services/bundlers/*.ts` |
| Keystore | Main key in memory while unlocked; secrets → scrypt `{N: 131072, r: 8, p: 1, dkLen: 64}` → AES-GCM (legacy AES-128-CTR migration path) | `ambire-common/src/libs/keystore/keystore.ts:20-28` (`SCRYPT_PARAMS` at `:28`, `CIPHER_OLD='aes-128-ctr'` `:20`, `CIPHER='AES-GCM'` `:24`), migration at `libs/keystore/keystore.ts:363-445`; `controllers/keystore/keystore.ts` is the controller (class at `:176`) |
| Provider injection | **Chromium:** the inpage bundles are registered from the background with `chrome.scripting.registerContentScripts({ … world: 'MAIN' })` (`handleScripting.ts:40,52,62`; comment: "Firefox versions older than 128.0 do not support world: MAIN"). **Firefox < 128 only:** the content script injects the inpage bundle as an inline `<script type="module">` whose text is substituted at build time. The inpage provider sets `isMetaMask = true`; EIP-6963 announce lives in `ambire-inpage.ts` with `rdns: 'com.ambire.wallet'`, `name: 'Ambire'` | `kohaku-extension/src/web/extension-services/background/handlers/handleScripting.ts:37-62`, `content-script/content-script-ethereum-injection.ts:1-16` (Gecko-only entry, `webpack.config.js:354-368`), `inpage/EthereumProvider.ts:103`, `inpage/ambire-inpage.ts:136-145` |
| Manifest | MV3 service worker; `permissions: storage, tabs, unlimitedStorage, activeTab, notifications` (+ `scripting`, `alarms` added by webpack `:110`); `host_permissions: http://*/*, https://*/*, file://*/*, wss://*/*`; `externally_connectable.ids: ["*"]` | `kohaku-extension/src/web/public/manifest.json`, `webpack.config.js:96-118` |
| Supported dapp RPC | an `RpcMethods` enum lists `eth_requestAccounts, eth_sendTransaction, personal_sign, eth_signTypedData, wallet_switchEthereumChain, wallet_addEthereumChain, wallet_getCapabilities, wallet_sendCalls, wallet_getCallsStatus, wallet_showCallsStatus`; note it is **not enforced as a whitelist** (`RPCMethod = keyof typeof RpcMethods | string`, `:31`) — we enforce ours | `background/provider/providerRequestTransport.ts:4-31` |
| Things worth reusing as *reference* | `controllers/erc7730` (clear-signing descriptors), `controllers/phishing` (+ `suspiciousHostingDomains.ts`), `controllers/privacyPools` (≈3,400 lines excluding its 3,947-line test; Kohaku Privacy Pools integration), `e2e-playwright-tests/` | directories in `ambire-common/src/controllers`, `kohaku-extension/e2e-playwright-tests` |
| Kohaku's own PQ account | `@kohaku-eth/pq-account` is a ZKNOX ERC-4337 account with Falcon/ETHFALCON/ML-DSA verification, 1.69M–8.40M gas; it is **not** SPHINCS- and not 8141 (a Foundry project, no `package.json`) | `repos/kohaku/packages/pq-account/README.md:3, 71-73` |

### 1.2 Cost of adding EIP-8141 + the LEAKED role model to that fork

1. The whole send pipeline (`accountOp` → `estimation` → `signAccountOp` → bundler/relayer → `submittedAccountOp`, `cancel.ts`, `replacement.ts`) is written around `AmbireAccount` calldata and 4337 `UserOperation`s (`ambire-common/src/libs/accountOp/*`). A type-0x06 transaction with a frame list, three signer roles on three sender contracts, and two mempools is a new pipeline, not a new driver.
2. The account contract is not ERC-7579, so LEAKED's 7579 policy module and the ERC-8286 frame validator (design doc, "Two account backends") cannot be installed into it. We would be replacing the account, the factory, the humanizer and the estimation controller, i.e. most of what the fork gives us.
3. The React-Native-web + Expo 47 + webpack toolchain and ethers v6 are a maintenance tax we do not need; our crypto/codec code is viem-native (the prototype and `@forshtat/hegota-support` already are).
4. GPL-3.0 is viral: forking means LEAKED is GPL-3.0. That is acceptable for a public good, but it also means Kohaku/Ambire code cannot be copied into an MIT SDK we want wallets to embed.

### 1.3 Decision `[DECISION]`

**Build from scratch, thin, viem-native, MIT-licensed, and ship the policy/frame logic as an SDK package that the Kohaku extension could later consume.** Rationale: the analysis (`../../ideas/01-LEAKED-critical-analysis.md` §3 row 8, §4 item 7) already scopes the extension as "a minimal spending-card + vault-console reference client"; the real distribution target is Kohaku/Ambire and 7579 wallets, which argues for a *library* they can import, not a fork they would have to merge upstream. Alternatives considered: MetaMask (custom limited license: "the number of monthly active users … do not exceed 10,000" `[VERIFIED]` via `MetaMask/metamask-extension/LICENSE`) is not forkable; Rabby is MIT ("Brand name and logo of Rabby is copyright reserved", `RabbyHub/Rabby/LICENSE:1,5`) and its `background.js / content-script / pageProvider.js / ui` split (`RabbyHub/Rabby/README.md:61-97` "Extension's Scripts"; there is no `notification.html` subsection) is the architecture we copy *in shape*, not in code.

What we take from Kohaku/Ambire without forking: the MV3 split, the dapp-RPC whitelist pattern, the scrypt→AES-GCM keystore parameters, the ERC-7730 descriptor controller as a reference, the Playwright e2e layout, and the `@kohaku-eth/*` SDK packages for Privacy Pools. **License caveat `[VERIFIED]`:** the `ethereum/kohaku` repo has **no LICENSE file** at the root or in `packages/{privacy-pools,plugins,provider}`; `privacy-pools` and `provider` declare `"license": "MIT"` in `package.json` only, and **`@kohaku-eth/plugins` (the `Host` interface we implement against) has no license field at all** (npm shows an empty license). Verification step: ask the Kohaku maintainers to add a LICENSE file / license field before we ship code that imports `@kohaku-eth/plugins`; until then treat it as "MIT-intended, unconfirmed" (R11).

### 1.4 Tech stack (versions checked on npm, 2026-11-06) `[VERIFIED]`

| Layer | Choice | Version / license | Why |
|---|---|---|---|
| Extension framework/bundler | **WXT** | 0.21.5, MIT (10.7k stars, pushed 2026-11-05) | MV3-first, generates manifest, HMR, Firefox build later |
| UI | React 18.3.x + Zustand | zustand 5.0.16 | Small; same React line as Kohaku |
| Data fetching | TanStack Query | 5.106.1 | Polling receipts/status with SW-restart-safe caches |
| Chain client | **viem** (+ `ox`) | viem 2.57.16, ox 1.8.13, MIT | 4337 via `viem/account-abstraction` (`sendUserOperation`, `estimateUserOperationGas`, `getUserOperationReceipt`, `waitForUserOperationReceipt`, `toSmartAccount` exist in `wevm/viem/src/account-abstraction/`) |
| 7579 helpers | permissionless | 0.5.2, MIT (`actions/smartAccount/{sendCalls,getCallsStatus,sendTransaction,signTypedData}.ts` exist) | Safe/Kernel account factories; `toSafeSmartAccount` takes `validators/executors/fallbacks/hooks` for 7579 (`docs.pimlico.io/references/permissionless/reference/accounts/toSafeSmartAccount`) |
| Smart sessions (4337 session policies) | `@rhinestone/module-sdk` 0.4.0 (MIT) — its GitHub README says it is **superseded** by `@rhinestone/sdk` (3.2.0), but `[VERIFIED]` only `module-sdk` 0.4.0 exports `getEnableSessionDetails` and the `{mode, permissionId, signature, enableSessionData}` form of `encodeSmartSessionSignature`; `@rhinestone/sdk` 3.2.0 has a different `encodeSmartSessionSignature(signers, validatorSignature)` and no `getEnableSessionDetails`. We pin `module-sdk` 0.4.0 for the enable flow. Policy contracts in `erc7579/smartsessions/contracts/external/policies`: `ERC20SpendingLimitPolicy, TimeFramePolicy, UniActionPolicy, UsageLimitPolicy, ValueLimitPolicy, SudoPolicy, ContractWhitelistPolicy, SimpleGasPolicy` (+ `ArgPolicy/`) | see §3.7 |
| Frame-tx codec | **own** `@leaked/frames` (profile-driven, ported from `@forshtat/hegota-support` 0.0.1, MIT) | see §4.1 |
| Crypto | `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0 (scrypt, keccak), `@scure/bip39` 2.4.0, `@scure/bip32` 2.4.0, `@noble/post-quantum` 0.7.1 (SLH-DSA `slh_dsa_shake_128s` etc. exported in `src/slh-dsa.ts:853-888`) | all MIT | hot key, KDF, SLH-DSA verification of vault replies (SPHINCS- C13 verifier comes from the crypto workstream, see §12) |
| Typed data | viem `hashTypedData` (fallback `@metamask/eth-sig-util` 9.0.0, ISC) | | EIP-712 hashing, ERC-7739 wrapping |
| QR | `@ngraveio/bc-ur` **2.0.0-beta.9** (the version the companion section pins, `20-pq-crypto-vault.md` §4.2; npm `latest` is still 1.1.13, which lacks the fountain API) with `UrFountainEncoder/UrFountainDecoder`, `nextPartUr()`, `receivePartUr()`, `isComplete()`, `maxFragmentLength` default 100 `[VERIFIED]` `repos/bc-ur/README.md:736-898`), `qrcode` 1.5.4 (render), `zxing-wasm` 3.1.6 (MIT) or `jsqr` 1.4.0 (Apache-2.0) (decode) | MIT/Apache-2.0 | §6 |
| Private reads | `@anon-rpc/browser-extension-harness` 0.4.0 (MIT) | | §9.6 |
| Tests | vitest, `@playwright/test` 1.64.1 | | §10 |

---

## 2. Architecture (Chromium MV3)

### 2.1 Components

```
 dapp page (MAIN world)          extension origin
 ┌──────────────┐  postMessage  ┌───────────────┐  runtime.Port  ┌──────────────────────────────┐
 │ inpage.js    │◄────────────►│ content.js    │◄─────────────►│ background service worker    │
 │ EIP-1193/6963│   (nonce'd)   │ (ISOLATED)    │               │  controllers + JSON-RPC router│
 └──────────────┘               └───────────────┘               │  storage.local / storage.session│
                                                                └──────┬──────────┬────────────┘
                                 ┌───────────────┐                     │          │
                                 │ popup.html    │◄────────────────────┘          │
                                 │ approve.html  │ (notification window)          │
                                 │ app.html      │ (full tab: onboarding, vault   │
                                 │               │  QR, bunker, privacy)          │
                                 └───────────────┘                                │
                                 ┌─────────────────────────────────────────────┐  │
                                 │ offscreen.html (one per extension)          │◄─┘
                                 │  - anon-rpc sandboxed iframe + worker       │
                                 │  - WASM worker pool (PQ verify, zxing)      │
                                 └─────────────────────────────────────────────┘
```

MV3 facts this design is built around (all `[VERIFIED]` on developer.chrome.com, fetched 2026-11-06):

- Service worker: terminated "after 30 seconds of inactivity"; a single request is killed "when a single request, such as an event or API call, takes longer than 5 minutes"; since Chrome 114 "sending a message with long-lived messaging keeps the service worker alive", extension API calls reset the timer (110), messages from an offscreen document reset it (109), active WebSockets extend it (116). (`/docs/extensions/develop/concepts/service-workers/lifecycle`)
- `chrome.storage.session`: "10 MB (1 MB in Chrome 111 and earlier)", "stored in-memory and will not be persisted to disk", "cleared if the extension is disabled, reloaded, updated, and when the browser restarts", "By default, it's not exposed to content scripts" (`setAccessLevel`). `chrome.storage.local`: 10 MB, more with `unlimitedStorage`. (`/docs/extensions/reference/api/storage`)
- Offscreen documents: Chrome 109+; "an installed extension can only have one open at a time"; reasons include `USER_MEDIA`, `WORKERS`, `DOM_PARSER`, `IFRAME_SCRIPTING`, `BLOBS`, `WEB_RTC`; no lifetime limit except `AUDIO_PLAYBACK`. (`/docs/extensions/reference/api/offscreen`)
- Alarms: "Chrome 120: Alarms can now be set to a minimum period of 30s to match the service worker lifecycle." (lifecycle page)
- Content scripts: `world: "ISOLATED" | "MAIN"`; `run_at: document_start`. The minimum Chrome version for a static `world: "MAIN"` manifest entry is **not on the page** → `[UNVERIFIED]`; what *is* documented is `chrome.scripting.registerContentScripts({world})` at Chrome 102+ ("Chrome 102: Dynamic content scripts in main world") `[VERIFIED]`. Verification step: load the manifest in the oldest Chrome we support and check `chrome://extensions` errors; fallback is Ambire's Chromium path, dynamic registration with `world: 'MAIN'` from the service worker (`[VERIFIED]` `kohaku-extension/.../handleScripting.ts:40-62`, §1.1), which needs the `scripting` permission; inline-script injection is only Ambire's Firefox < 128 path.
- CSP: `extension_pages` minimum is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` and "cannot be relaxed beyond this minimum"; sandbox pages default `sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';`. Remotely hosted code is forbidden ("RHC is not allowed"; data/JSON is fine). (`/docs/extensions/reference/manifest/content-security-policy`, `/develop/migrate/remote-hosted-code`)
- Side panel: Chrome 114+, "As an extension page, side panels have access to all Chrome APIs." Optional home for the vault console; not required.

### 2.2 Service worker: controllers and the JSON-RPC router

One `background.ts` entry registers the listeners synchronously at top level (required for MV3 event delivery after a cold start) and lazily hydrates a `Controllers` singleton from storage:

| Controller | State (persisted in `storage.local` unless noted) | Responsibility |
|---|---|---|
| `KeyringController` | encrypted vault blob; unlocked DEK in `storage.session` | §2.4 |
| `AccountsController` | account list `{address, backend: 'frame'|'4337', chainIds[], roleSigners{vault,recovery,guardian}, factory, salt}` | address derivation (§8), role-signer addresses |
| `NetworksController` | chain table (§8), RPC URLs, mempool endpoints, profile id | per-chain config, Anon-RPC worker handles |
| `PolicyCacheController` | cached on-chain config: cap, bucket usage, allowlists, session policies, frozen/bunker flags, pending timelocked actions | read via Anon-RPC on an alarm (60 s) + on every send |
| `PermissionsController` | dapp origin → `{accounts, chainId, grantedAt}`; dapp request queue in `storage.session` | EIP-2255-style permissions, approval windows |
| `ProviderController` | – | the method table of §3 |
| `FrameEngine` | pending frame txs `{hash, chainId, route, raw, submittedAt, replacementOf}` | §4 |
| `UserOpEngine` | pending userOps `{userOpHash, bundler, …}` | 4337 backend |
| `Router` | last routing decisions with rule IDs | §5 |
| `VaultQueueController` | unsigned vault requests, scanned responses, timelock queue mirror | §6 |
| `WatcherController` | last seen block/event cursor, alert list | §6.5 |
| `PrivacyController` | Kohaku plugin host state (scoped) | privacy section |
| `SettingsController` | auto-lock minutes, Anon-RPC on/off, theme | |

All controller writes are write-through to `chrome.storage.local` (debounced ≤100 ms, flushed before the handler returns). Nothing of importance lives only in SW memory, because the SW can die 30 s after the last event `[VERIFIED]`.

### 2.3 Message passing

- inpage ↔ content script: `window.postMessage` with a per-page random channel id generated by the content script and handed to the inpage script at injection time; messages are `{channel, id, method, params}` / `{channel, id, result|error}`. The inpage script never sees the extension id.
- content script ↔ SW: one `chrome.runtime.connect({name: 'leaked-provider'})` port per tab/frame. The SW stamps every request with `port.sender.origin` and `port.sender.tab.id`/`frameId`; the origin in the inpage payload is ignored. Port messages keep the SW alive (Chrome 114+ `[VERIFIED]`), and a port disconnect on SW death triggers the content script to reconnect with backoff, replaying unanswered request ids.
- UI pages ↔ SW: `chrome.runtime.sendMessage` request/response + a `chrome.storage.onChanged` subscription for state (the UI reads state from storage, never from SW memory, so it survives SW restarts).
- Offscreen ↔ SW: `chrome.runtime.sendMessage` with a `target: 'offscreen'` discriminator (our convention, the standard Chrome-docs pattern; **not** something the anon-rpc harness README shows — its "Use" section is `new AnonRpcWorker({ address, preExisting: { rpcProvider } })` and its "If your extension already has an offscreen document" section (`README.md:140`) uses `mountOffscreenHost()` + `offscreenUrl: false` `[VERIFIED]` `repos/anon-rpc/impl/browser-extension-harness/README.md:113-150`). Because an extension may have **only one** offscreen document `[VERIFIED]`, `offscreen.html` is owned by this section and hosts both the anon-rpc sandbox (via `mountOffscreenHost()`) and the privacy section's prover worker (§9.6, `40-privacy-infra.md` §1.3).

### 2.4 Keyring

- Seed: BIP-39 (24 words, `@scure/bip39`); hot key `m/44'/60'/0'/0/0` (`@scure/bip32`). Additional hot keys (for rotation) at index `n+1`. **Tank key** (the default-code payer EOA of the hot tx, `10-contracts.md` §10.2.2/§10.3.9) on a separate branch, `m/44'/60'/1'/0/k`, so a hot-key rotation never moves the tank and a tank export never reveals the hot key. No PQ key material ever enters the extension (design doc: vault/recovery keys live on the companion device).
- Encryption: password → **scrypt** `N=2^17, r=8, p=1, dkLen=32` (`@noble/hashes/scrypt`; the same N/r/p Ambire uses `[VERIFIED]` `ambire-common/src/libs/keystore/keystore.ts:28`) → WebCrypto `AES-256-GCM` with a random 12-byte IV per write; AAD = `{version, address}`. Blob format `{v:1, kdf:{name:'scrypt',N,r,p,salt}, cipher:{name:'AES-GCM',iv}, ct, tag}`. Scrypt with N=2^17 takes ~1–2 s on a laptop; run it in a Web Worker inside the unlock page, not in the SW (5-minute cap is not the issue; UI responsiveness is).
- Unlocked state: the derived DEK (not the password) is kept in `chrome.storage.session` (in-memory, non-persistent, content scripts cannot read it by default `[VERIFIED]`). Auto-lock: a `chrome.alarms` alarm (`periodInMinutes` ≥ 0.5 `[VERIFIED]` Chrome 120+) checks `lastActivity`; default 15 min; "lock when the browser closes" is automatic because `storage.session` is cleared on restart.
- Signing happens only in the SW, from the DEK in `storage.session`; UI pages never receive private key bytes.
- Threat bound (design doc "Hot" row): compromise of the extension process is bounded by the on-chain cap; this is the whole point, so we deliberately do not promise more from the keyring than "as good as Ambire/Rabby".

### 2.5 Manifest (minimal) `[VERIFIED-against-docs]`

```jsonc
{
  "manifest_version": 3,
  "name": "LEAKED",
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "permissions": ["storage", "alarms", "offscreen", "notifications"],
  "optional_permissions": ["sidePanel"],
  "host_permissions": [
    "https://altmempool.forshtat.com/*", "https://altmempoolgateway.forshtat.com/*",
    "https://*.<our-resolver>/*"               // anon-rpc worker bundle resolvers only
  ],
  "content_scripts": [
    { "matches": ["http://*/*", "https://*/*"], "js": ["content.js"], "run_at": "document_start", "all_frames": true },
    { "matches": ["http://*/*", "https://*/*"], "js": ["inpage.js"],  "run_at": "document_start", "world": "MAIN", "all_frames": true }
  ],
  "sandbox": { "pages": ["anon-rpc/*/sandbox.html"] },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src https: wss:; img-src 'self' data:; frame-src 'self'",
    "sandbox": "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; child-src 'self' blob:; worker-src 'self' blob:; connect-src *;"
  }
}
```

Notes: no `tabs`, no `<all_urls>` host permission (the content-script `matches` already produce the "read and change all your data on websites" install warning; RPC fetches go to the listed hosts only, and dapp-provided RPC URLs via `wallet_addEthereumChain` are not supported in v1, §3). No `externally_connectable` (Ambire's `ids: ["*"]` lets any extension message the wallet; we do not want that). The `sandbox` + `content_security_policy.sandbox` entries are copied verbatim from the anon-rpc extension harness README (`[VERIFIED]`, it explains why `blob:` in `script-src` is required). `'wasm-unsafe-eval'` is the maximum relaxation Chrome allows for extension pages `[VERIFIED]`.

---

## 3. The provider layer

### 3.1 EIP-1193 + EIP-6963

- `inpage.js` creates one `LeakedProvider` (EventEmitter, `request({method, params})`, events `connect`, `disconnect`, `chainChanged`, `accountsChanged`). It does **not** set `window.ethereum` and does **not** set `isMetaMask` (Ambire does, `[VERIFIED]` §1.1; we avoid the resulting mis-detection). Discovery is EIP-6963 only: dispatch `eip6963:announceProvider` with a frozen `{info:{uuid (UUIDv4 per page load), name:'LEAKED', icon:<data: URI, SVG rendered via <img> only>, rdns:'xyz.leaked.wallet'}, provider}` on load and again on every `eip6963:requestProvider` (`[VERIFIED]` `repos/eips/EIPS/eip-6963.md:46-163`). A settings toggle "also expose as window.ethereum (legacy dapps)" exists but is off by default.
- Error codes (`[VERIFIED]` `eip-1193.md:149-156`): `4001` user rejected, `4100` unauthorized, `4200` unsupported method, `4900` disconnected, `4901` chain disconnected; JSON-RPC `-32601` method not found, `-32602` invalid params. EIP-5792 adds (`eip-5792.md:387-393`): `5700` unsupported non-optional capability, `5710` unsupported chain id, `5720` duplicate id, `5730` unknown bundle id, `5740` bundle too large, `5750` atomic-ready wallet rejected upgrade, `5760` atomicity not supported. EIP-3326 (`wallet_switchEthereumChain`) defines no error code of its own (`[VERIFIED]` `eip-3326.md`: "an error otherwise"); `4902` "unrecognized chain" is the MetaMask convention that wagmi/viem key the add-chain fallback on, so we return `4902` for a chain id not in our table and `4901` only for a known chain the account has no backend on.
- LEAKED policy denials are returned as `4100` with `error.data = { leakedRule: '<RULE-ID>', explanation, remedy }` (rule IDs in §5). This is a project convention, not a standard: 1193 has no "policy denied" code, and `4001` would be a lie because the *user* did not reject.

### 3.2 Method table

Legend: **F** = frame-native backend (8141 account + role senders), **U** = ERC-4337 + ERC-7579 backend. "hot" = signed by the hot key in the extension. "cap" = checked against the cached rolling cap/allowlist (pre-check in the extension; enforced on-chain in execution per the design doc).

| Method | F behaviour | U behaviour | Errors |
|---|---|---|---|
| `eth_requestAccounts` | approval window (origin, chain) → `[account]`; stores permission | same | `4001` |
| `eth_accounts` | `[account]` if permitted else `[]` | same | – |
| `eth_chainId` / `net_version` | from `NetworksController` | same | – |
| `wallet_switchEthereumChain` | switch within the fixed chain table (§8); emits `chainChanged`; unknown chain id → `4902` (convention, see §3.1); known chain but the account has no backend there → `4901` | same | `4902`, `4901`, `-32602` |
| `wallet_addEthereumChain` | **unsupported** in v1 (fixed table; dapp RPC URLs would bypass Anon-RPC) | same | `4200` |
| `eth_sendTransaction` | cap pre-check → build the hot frame tx of §4.2 (`[only_verify(account), pay(tank EOA), SENDER(account, hotExecute(declaredUsd, calls))]`, two hot-side SECP256K1 signatures) → route (§5) → returns the **type-0x06 tx hash** | cap pre-check → `UserOperation` via the policy-module validator → bundler → returns the **userOpHash**; `eth_getTransactionReceipt`/`eth_getTransactionByHash` for a known userOpHash are answered from `eth_getUserOperationReceipt(...).receipt` (same trick Ambire/Safe use; `[VERIFIED]` ERC-4337 defines `eth_getUserOperationReceipt`, `repos/ercs/ERCS/erc-4337.md:264`) | `4001`, `4100`+rule, `-32602` |
| `eth_signTransaction` | unsupported (a contract account has no raw tx to hand back) | same | `4200` |
| `eth_sign` | unsupported (blind hash signing) | same | `4200` |
| `personal_sign` | **scoped 1271 (a)**: hot key signs the ERC-7739 `PersonalSign` nested hash (`[SPEC-DRAFT]` `erc-7739.md:218-229`; line 69 only names the two workflows), **only** if the origin is on the login-domain allowlist and, for SIWE text, the message `domain` equals the requesting origin host; returns 7739-wrapped signature bytes | same (the 7579 account's 1271 does the 7739 rehash) | `4100`+`SIG-DOMAIN-NOT-ALLOWED`, `4001` |
| `eth_signTypedData_v4` | classify (§3.4): zero-value → 7739 `TypedDataSign` by the hot key; value-bearing → **on-chain hash registration** via `hotExecute` (frame tx), returns a registration marker signature | same, registration via a userOp | `4100`+`SIG-*`, `4001` |
| `eth_signTypedData`, `_v1`, `_v3` | unsupported | same | `4200` |
| `wallet_getCapabilities` | per chain: `atomic: {status:'supported'}` (frames can be atomic-batched, EIP-8141 flag bit 2 `[SPEC-DRAFT]`), `paymasterService` absent, plus a LEAKED-namespaced `leaked: { backend:'frame', capUsd, capRemainingUsd, sessionPolicies:[…] }` | `atomic: supported` (7579 batch execute), `backend:'4337'` | `4100` |
| `wallet_sendCalls` | `calls[]` → **one** SENDER frame `hotExecute(declaredUsd, calls[])` (the contracts section's hot VERIFY only admits SENDER frames to the account itself with the `hotExecute` selector, `10-contracts.md` §10.5.1 step 6, so calls are batched *inside* `hotExecute`, atomic by construction; `ATOMIC_BATCH_FLAG` is not used); `atomicRequired:false` is still executed atomically (allowed by 5792 `[VERIFIED]` `eip-5792.md:64-67`); returns `{id}` where id = tx hash unless the app supplied an `id`, which "the wallet MUST respect … and return" (`[VERIFIED]` `eip-5792.md:74-78`, unique string ≤ 4096 bytes) | `calls[]` → one userOp with 7579 batch mode; id = userOpHash | `5700`, `5710`, `5740` (calldata/`maxHotFrames` bound from the account config), `5760` if `atomicRequired` and the account is not yet deployed, `4001`, `4100` |
| `wallet_getCallsStatus` | `status` 100/200/400/500/600 from the frame receipt (§4.6); `atomic:true`; `receipts:[translated receipt]` | from `eth_getUserOperationReceipt` | `5730` |
| `wallet_showCallsStatus` | opens the activity page on that id | same | `5730` |
| `wallet_requestExecutionPermissions` (ERC-7715) | maps to a **vault-issued session policy** (§3.7); the request stays pending while the vault QR round-trip happens; `permissionsContext` = encoded policy id | maps to Smart Sessions enable flow | `4200` if the permission type is unknown, `4001` |
| `wallet_revokeExecutionPermission` / `wallet_getGrantedExecutionPermissions` / `wallet_getSupportedExecutionPermissions` (`[VERIFIED]` all four method names in the current ERC-7715 text, `erc-7715.md:209`) | revoke = hot-key tx (tightening is instant per the design doc); list from `PolicyCacheController` | same | – |
| `wallet_requestPermissions` / `wallet_getPermissions` / `wallet_revokePermissions` | `eth_accounts` only | same | – |
| `wallet_watchAsset` | adds to the token list (no chain effect) | same | – |
| `wallet_connect` / `wallet_disconnect` (ERC-7846) | optional; v1 returns `4200` | | |
| `wallet_prepareCalls` / `wallet_sendPreparedCalls` (ERC-7836) | unsupported (the dapp would need to sign a frame-tx digest; we never hand out sig hashes to pages) | | `4200` |
| `eth_subscribe` / `eth_unsubscribe` | unsupported | | `4200` |
| read methods (`eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_blockNumber`, `eth_getLogs`, `eth_getCode`, `eth_getTransactionCount`, `eth_feeHistory`, `eth_gasPrice`, `eth_getBlockByNumber`, …) | whitelist, forwarded through Anon-RPC with `isolationKey = account` (§9.6) | same | `-32601` if not whitelisted |
| any `leaked_*` | internal, rejected from pages | | `-32601` |

### 3.3 What the dapp sees as the account

The account address is the smart account (same on both backends if §8 holds). `eth_requestAccounts` never returns the hot EOA. Dapps that check `eth_getCode(account) != 0x` get a contract (SIWE libraries then use 1271; Permit2 uses 1271; OpenSea/Seaport uses 1271).

### 3.4 Typed-data classification (scoped 1271)

Deterministic, not heuristic:

1. **Known value-bearing schemas** (registry shipped with the extension, keyed by `primaryType` + field names): ERC-2612 `Permit`, Permit2 `PermitSingle` / `PermitBatch` / `PermitTransferFrom` / `PermitBatchTransferFrom` / `PermitWitnessTransferFrom`, Seaport `OrderComponents` / `BulkOrder`, CoW `Order`, UniswapX `ExclusiveDutchOrder` / `PriorityOrder`, 1inch `Order`. → path (b): the extension extracts `(token, amount, spender/taker, deadline)` for the cap check, builds `hotExecute(declaredUsd, [registerHash(bytes32 hash, address token, uint256 amount, uint48 expiry)])` (signature per `10-contracts.md` §10.11) and returns **empty signature bytes** `0x` as the "signature": the contracts section specifies that "the registered-hash path accepts empty signature" (`10-contracts.md` §10.11). The account's `isValidSignature(hash, 0x)` returns the magic value iff the hash is registered and not expired. **Compatibility risk `[UNVERIFIED]`:** some dapp SDKs reject a zero-length signature client-side before ever calling 1271; verification step: run the matrix (§10.1) with `0x` and, if any cell fails only for that reason, ask contracts to also accept a 36-byte marker `bytes4(REGISTERED_MARKER) ‖ hash` (both forms are cheap to support). Dapps that verify with `ecrecover` off-chain instead of 1271 (rare for contract wallets; CoW does support 1271 pre-signed orders) are listed as incompatible in the matrix (§10).
2. **Known zero-value schemas**: SIWE-712 variants, Snapshot `Vote`/`Proposal`, ENS, Farcaster, Lens, generic "login/nonce/challenge" types with no `uint` amount field. → path (a): ERC-7739 `TypedDataSign` (`[SPEC-DRAFT]` `erc-7739.md:71-213`, layout at `:175`: signature = `originalSignature ‖ APP_DOMAIN_SEPARATOR ‖ contents ‖ contentsDescription ‖ uint16(contentsDescription.length)`), hot key, origin must be on the login-domain allowlist.
3. **Unknown schema**: treated as value-bearing with `budgetUsd = 0` and `domain.verifyingContract` must be on the target allowlist; otherwise `4100` `SIG-UNKNOWN-SCHEMA` with the "ask your vault to allowlist this contract" remedy. Never silently signed.

The vault's PQ key is never used for any 1271 path (design doc). The UI always shows the classification and the extracted amounts (ERC-7730 descriptors where available).

### 3.5 Receipt translation (frame → standard receipt)

`eth_getTransactionReceipt` on ethrex returns the standard fields plus `frameReceipts` (`[VERIFIED]` `repos/mempool-workshop/src/lib/frameTx/send.ts:24-41`, `rpc-methods.md` "Other changes"). The EIP's consensus receipt has **no transaction-level status** (`eip-8141.md:246` `[SPEC-DRAFT]`) and ethrex's JSON adds one. For dapps we return the node's receipt unchanged (dapps using viem/ethers ignore unknown fields) and set `status` as follows for `wallet_getCallsStatus`: all `user_op` frames `0x1` → `200`; prefix ok but a body frame `0x0`/`0x2` (skipped) → `600` partial (or `500` if every body frame failed); not mined / dropped → `100` / `400`.

### 3.6 Approval UX contract

Every write method opens `approve.html` in a notification window keyed by request id; the request is persisted in `storage.session` so an SW restart re-opens it. Approval screens show: origin (from the port sender, not the page), chain, the decoded call (ERC-7730 descriptor → human text; else 4-byte + ABI from a bundled registry; else raw), the **route** with rule IDs (§5), cap impact ("uses $42 of $500 left today"), and for 1271 the classification of §3.4.

### 3.7 Session policies

- **F backend:** policy `(target, selector, spendAllowance, expiry)` is installed on-chain by a vault-signed `VaultSigner` tx (§6). The hot key then sends normal `[self_verify, user_op]` txs; the account's execution-phase check finds a matching policy and debits its allowance instead of the general bucket. The extension's `Router` prefers a session policy when one matches (rule `ROUTE-SESSION-MATCH`).
- **U backend:** the same tuple is installed as a Smart Sessions session with `ContractWhitelistPolicy` + `UniActionPolicy` (selector) + `ERC20SpendingLimitPolicy`/`ValueLimitPolicy` + `TimeFramePolicy` (`[VERIFIED]` policy contract names in `erc7579/smartsessions/contracts/external/policies`); enabling a session is a vault-approved action (the vault is a 7579 validator owner in the module, interface in §12). `[UNVERIFIED]`: that the Smart Sessions enable flow accepts a non-ECDSA (contract/1271) session-enable signature; `[VERIFIED]` the helpers live in `@rhinestone/module-sdk` 0.4.0 (`getEnableSessionDetails`, `encodeSmartSessionSignature({mode, permissionId, signature, enableSessionData})`), **not** in `@rhinestone/sdk` 3.2.0 (§1.4); verification step: read those two functions and `SmartSession.sol`'s enable-signature check in `repos/smartsessions`, then test on Sepolia with a 1271 signer.
- ERC-7715 mapping: `permission.type` → our tuple; `rules: [{type:'expiry'}]` → `expiry` (`[SPEC-DRAFT]` `erc-7715.md:56-70`); unknown permission types → `4200`.

---

## 4. The frame-transaction engine

### 4.1 Encoder/decoder: own, profile-driven `[DECISION]`

Evidence of spec drift that forces a profile mechanism:

| Item | Current EIP text | ethrex `eip8141-tracer` devnet (chain 1337) | ethrex `hegota-devnet` (chain 3151908) |
|---|---|---|---|
| Payload | `[chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes]`, `fees = [max_fee, max_priority_fee_per_gas]` where `max_fee` is a **total wei budget** (`[SPEC-DRAFT]` `eip-8141.md:66-90`) | 9 items: `[chainId, nonceKeys, nonceSeq, sender, frames, signatures, fees[prio,max,blob], blobVersionedHashes, recentRootReferences]` (`[VERIFIED]` `repos/hegota-support/src/profiles/ethrex-eip8141-tracer.ts:37-48`) | 11 items, three fee items top-level, frame mode `POST_TX` (`ethrex-hegota-devnet.ts:34-48`) |
| Sig hash | elided `signature` replaced by its **byte length** as an RLP uint (`eip-8141.md:248-262`) | elided to the empty string (`repos/hegota-support/src/tx/codec.ts:187-193`; the prototype's PORST tx relied on this plus fixed-length padding, `prototype/probe.mts:104-121`) | same as devnet 1337 |
| Signature schemes | `0x0 ARBITRARY, 0x1 SECP256K1 (v‖r‖s, v∈{0,1}, low-s), 0x2 P256` (`eip-8141.md:216-232, 289-314`) | `ARBITRARY, SECP256K1, P256` (`[VERIFIED]` sidecar `packages/types/src/contracts/FrameTx.ts:33-37`; ARBITRARY accepted by the devnet, prototype probe 2026-10-24) | `ARBITRARY, SECP256K1` |
| Nonce | `nonce` (linear) | EIP-8250 keyed `nonceKeys[]` + `nonceSeq`, max 16 keys (`FrameTx.ts:86-90`) | same |

viem's frame support is **not released**: `[VERIFIED]` GitHub API 2026-11-06 — #4486 (fork, "EIP-8141 - Frames Transactions") and #5118 are **closed unmerged**; #5119, #5121, #5158 were merged on 2026-09-27/30 into the feature branches `jxom/frame-transaction-codecs` / `jxom/frame-transaction-rpc`, not `main`; the umbrella PR **#5165 "feat(eip8141): frame transactions" (head `jxom/frametxs`, base `main`) is open, last updated 2026-10-01**. Docs exist only on that branch (`site/pages/docs/frames/{index,building-frames,calls,expiry,from,raw-frames,sending-transactions,sign}.mdx`, `src/frames/{Frame,calls,expiry}.ts`); `https://viem.sh/docs/frames` is HTTP 404 and `src/frames` is absent on `main`. Separately, **`ox` 1.8.13 ships `TxEnvelopeEip8141`** (`src/core/TxEnvelopeEip8141.ts`, exported as `./TxEnvelopeEip8141`) `[VERIFIED]` — which EIP revision it encodes (2-item `fees`? length-committing sig hash?) is `[UNVERIFIED]`; verification step: encode the workshop `self_verify` fixture with `ox` and compare to `@forshtat/hegota-support` per profile before considering it as the `eip8141-current` codec. It targets the EIP text (2-item fees, linear nonce), not the devnets. So: `@leaked/frames` = a port of `@forshtat/hegota-support`'s `Profile` type (`repos/hegota-support/src/profiles/types.ts`), `encodeTx/decodeTx/sigHash/txHash/signTx` (`src/tx/codec.ts`) and `toWire` (`src/rpc/wire.ts`), with three profiles (`eip8141-current`, `ethrex-eip8141-tracer`, `ethrex-hegota-devnet`) selected by chain id, plus pinned test vectors per profile. When viem #5165 merges we add a fourth profile mapping and can swap the codec behind the same interface.

### 4.2 Transaction shapes

**Canonical shapes are owned by the contracts section (`10-contracts.md` §10.2.2, §10.6); the layouts below are copied from it so the extension builds exactly what the account's VERIFY frame-walker admits.** (The previous draft of this section had a one-signature `[self_verify, SENDER×n]` hot shape and a path-B shape with the PQ signature in calldata; both contradicted §10 and were replaced, see the verification log.)

Hot spend (public mempool; prefix shape `[only_verify, pay]` = the EIP's "Canonical Paymaster"/default-code payer shape, structural rules 1, 3, 6, 8 `[SPEC-DRAFT]` `eip-8141.md:995-1003, 1015-1028`; the EIP has no `self_relay` identifier, its headings are "Self Relay"/"Canonical Paymaster" and the subclass names are `self_verify, deploy, only_verify, pay, expiry_verify, user_op, post_op` `[VERIFIED]` `eip-8141.md:964-970`):

```
frames[0] = VERIFY, flags = 0x2 (APPROVE_EXECUTION, "only_verify"), target = null (= account), data = abi.encodeCall(verifyFrame, ()) (4 bytes — NOT 0x: empty calldata would hit receive(), §10.3.2), limits.execution ≤ 80k (§10.5.1)
frames[1] = VERIFY, flags = 0x1 (APPROVE_PAYMENT, "pay"), target = tankEOA (default code, no contract), data = 0x
frames[2] = SENDER, target = account, value = 0, data = hotExecute(uint256 declaredUsd, Call[] calls)   // ONE frame; batches go inside `calls`
signatures = [ {SECP256K1, signer: hotKey, msg: 0x}, {SECP256K1, signer: tankEOA, msg: 0x} ]            // default code uses sig index 1 for a pay-only frame (eip-8141.md:729-734)
```

Self-paid variant (user opts out of a tank; `S.selfPay` in the account config): `frames[0] = VERIFY 0x3 (APPROVE_EXECUTION_AND_PAYMENT, "self_verify"), data = verifyFrame()`, one signature. Over-cap reverts then burn the account's own ETH, not a tank's, which is why the tank layout is the default (design doc "gas tank"). The **tank key** is a second extension-held secp256k1 key (`10-contracts.md` §10.2.2: "The tank key lives in the extension next to the hot key"); see §2.4 for its derivation path.

The account's VERIFY reads only its own storage (hot key, frozen flag, static per-tx max, allowlist) and `TXPARAM/FRAMEPARAM/SIGPARAM` (design doc "Hot tier rules"; `SIGPARAM_RESOLVED_SIGNER` `[SPEC-DRAFT]` `eip-8141.md:892`), so it is public-mempool eligible (policy summary items 1 and 3, `eip-8141.md:945-956`). The tank frame is a default-code frame, evaluated directly (`eip-8141.md:1044-1046`).

Role-signer tx (sender = `PQRoleSigner` with `role ∈ {VAULT, RECOVERY}`, its own nonce; the design doc's `VaultSigner`/`RecoverySigner` are the two instances of this one contract, `10-contracts.md` §10.3.6). Path B (public mempool):

```
frames[0] = VERIFY 0x3 on roleSigner, data = verifyFrame(0): checks SIGPARAM(1, RESOLVED_SIGNER) == payerKey (ECDSA, on the vault device), walks frames
frames[1] = SENDER, target = roleSigner, value = 0, data = executePQ(0, account, roleCalldata)   // PQ verified inside executePQ (execution), then account.<vault*/recovery*>(…); self-admin = executePQ(0, roleSigner, …)
signatures = [ {ARBITRARY, signer: 0x, msg: 0x, signature: PQ witness of exactly sigLength bytes},   // entry 0, over TXPARAM_SIG_HASH
               {SECP256K1, signer: payerKey, msg: 0x} ]                                              // entry 1, also over the sig hash; both come back by QR
```

Path A (alt mempool, role signer staked):

```
frames[0] = VERIFY 0x3 on roleSigner, data = verifyFrame(0), limits.execution = measured PQ verify gas (≤ staked budget); PQ verified in VERIFY
frames[1] = SENDER, target = roleSigner, data = relay(account, roleCalldata)      // self-admin (stake, setPayerKey, …) = relay(roleSigner, …)
signatures = [ {ARBITRARY, signer: 0x, msg: 0x, signature: PQ witness} ]
```

The fixed length matters: under the current EIP the sig hash commits to the elided signature's **length**, and "schemes with variable-length output must encode to a length fixed in advance" (`eip-8141.md:261` `[SPEC-DRAFT]`). SPHINCS- C13 is fixed-length: **3,688 bytes** (`20-pq-crypto-vault.md` §1.1, §2.5; the "3.7 KB" in the analysis is this number rounded); the crypto workstream owns the exact byte length per scheme (`IPQVerifier.sigLength()`, §12).

### 4.3 Signature-hash computation

`sigHash(profile, tx)`: elide every entry with `msg == 0x` (per profile: to `0x` on the devnets, to `uint(len)` on `eip8141-current`), `keccak256(0x06 ‖ rlp(payload))`. For the vault the extension computes this hash **with the signature entries already sized** (dummy bytes of the final length) and ships both the unsigned tx and the hash in the QR request; the vault device recomputes the hash itself from the tx (it must not trust the extension's hash, analysis F10 "clear signing") and the extension verifies the returned signature locally (`@noble/post-quantum` for SLH-DSA; SPHINCS- C13 verifier from the crypto workstream) before broadcasting, so a corrupted QR never burns a role-signer nonce.

### 4.4 Gas estimation

| Where | Method | Shape | Status |
|---|---|---|---|
| Sidecar (alt mempool) | `eth_estimateFrameTransactionGas([partialTx])` — needs `sender` and `frames`; `signatures`, `fees`, `nonce` optional | returns `{frames:[{execution,state}], cumulativeGasUsed, maxFeePerGas, maxPriorityFeePerGas}`; prefix frames keep their limits, body frames are simulated with a large placeholder and marked up | `[VERIFIED]` `rpc-methods.md`, `packages/executor/src/modules/interfaces.ts:47-54`; probed: `/rpc` answers with validation errors for `[{}]`; the ethrex endpoint answers `-32601` |
| ethrex | `ethrex_simulateFrameTransaction([rawTx, block?, {trace:true}?])` — `rawTx` is `0x06‖rlp`, **not** JSON | `{valid, prefixShape, payer, maxCost, violation, gasUsed, frames, executionStatus, executionError, erc7562Trace?}` | `[VERIFIED]` `rpc-methods.md`; probed: `[{}]` → `Invalid params: invalid type: map, expected a string` (method exists). Known gap: every prefix failure reads `validation prefix frame reverted` (`repos/mempool-workshop-sidecar/docs/ethrex-requests.md`) |
| Any node | `eth_estimateGas` per SENDER frame with `from = account` | fallback for body frames when neither method exists | `[VERIFIED]` standard |
| Fees | `skandha_getGasPrice` → `{maxPriorityFeePerGas, maxFeePerGas}` (probed OK) or `eth_feeHistory`/`eth_maxPriorityFeePerGas` | | |

The hot VERIFY limit is a constant per account version (measured by the contracts workstream; the prototype used 80k for a secp256k1 wallet, `prototype/probe.mts:153`), never estimated at runtime. Frame `limits.state` is non-zero for transfers to fresh accounts ("A transfer that creates a new account needs a non-zero state gas limit", `choosing-a-mempool.md` `[VERIFIED]`); we use the estimator's `state` value or 200k fallback (`build.ts:44`). Under the current EIP the outer fee is a **total** `max_fee` in wei (sum of frame limits × max fee per gas + blob) — the profile layer converts.

### 4.5 Nonces

- Hot account: linear key `[0]`, `nonceSeq = eth_getTransactionCount(account, 'pending')` from the node that will receive the tx; the public mempool keeps alternatives per `(sender, nonce)` (`eip-8141.md:1159` `[SPEC-DRAFT]`). Local pending map prevents reusing a nonce while a tx is in flight; after an SW restart the map is rehydrated and reconciled against `eth_getTransactionCount`.
- Role signers: each `PQRoleSigner` instance (vault, recovery) and `GuardianSigner` is its own sender with its own nonce (design doc "separate 8141 sender contracts"); the extension embeds the nonce in the QR request (it is inside the unsigned RLP, which the device re-decodes). The device keeps a signature counter (a budget counter for the stateless C13 scheme; a true write-ahead index only for the unscheduled PORST path, `20-pq-crypto-vault.md` §3.3, §4.6) — it does **not** promise to refuse a repeated nonce, so the extension must track vault txs by `(sender, nonce, sigHash)` and never request a second signature for a nonce whose first signature it still holds unbroadcast (§6.3).
- Keyed nonces (EIP-8250) are supported by the codec (profiles with `nonceKeys`) and offered only on the alt mempool for agent-style concurrency; off by default (alt-mempool budget note: "a VERIFY frame with 7 nonce keys ran out of gas at 30,000", `rules/budget.md` `[VERIFIED]`).

### 4.6 Submission, status, receipts

| Target | Submit | Status | Receipt |
|---|---|---|---|
| Public (canonical) mempool via an ethrex node | `eth_sendRawTransaction(0x06‖rlp)` (`[VERIFIED]` `repos/mempool-workshop/src/lib/frameTx/send.ts:20-23`; `rpc-methods.md` "eth_sendRawTransaction accepts type-0x06") | poll `eth_getTransactionByHash` | `eth_getTransactionReceipt` + `frameReceipts[]` (`send.ts:24-29`) |
| Alt mempool via the sidecar `/rpc` | `eth_sendFrameTransaction([toWire(tx)])` — JSON with 0x-quantities, `[VERIFIED]` `repos/hegota-support/src/rpc/wire.ts:7-30`, `send.ts:11-14`; the gateway validates, then gossips to the miner (`workshop.config.json5:7-10`) | `skandha_frameTransactionStatus([hash])` → `{tx, sender, payer, factory?, status ∈ New|Pending|Submitted|OnChain|Finalized|Cancelled|Reverted, transaction?, reason?}`; unknown hash → JSON-RPC error `-32600 "Frame transaction not found"` (probed) | `eth_getFrameTransactionReceipt([hash])` → `{status, payer, cumulativeGasUsed, frameReceipts:[{status, gasUsed:{execution,state}, logs}]}`; errors `-32000 "transaction receipt not found"` until mined (probed); `eth_getFrameTransactionByHash` returns the mempool entry or `null` |
| Push (optional) | — | `skandha_subscribe(['pendingUserOps'|'submittedUserOps'|'onChainUserOps'])` over WebSocket, events as `skandha_subscription` (`[VERIFIED]` `docs/sidecar_subscribe.md`); a WebSocket keeps the SW alive (Chrome 116 `[VERIFIED]`) but we poll with alarms instead to keep the SW idle | |

Per-frame status: `0x1` success, `0x0` revert, `0x2` skipped by a failed atomic batch (`eip-8141.md:244, 879` `[SPEC-DRAFT]`); the sidecar decodes it to `"success" | "reverted" | "skipped"` (`packages/types/src/executor/validation/frameTxReceipt.ts:22`). The activity screen shows one row per frame.

### 4.7 Replacement and cancel

- Public mempool: a replacement is the same `(sender, nonce)` with `max_fee` **and** `max_priority_fee_per_gas` raised by the node's minimum increment, "10% is the conventional default" (`eip-8141.md:1161` `[SPEC-DRAFT]`); the sidecar treats conflicting txs as replacements (`rules/lifecycle.md` `[VERIFIED]`) and ERC-8421 counts a replacement as no new `seen` for unchanged entities (`REPUTATION-040`). Any replacement needs a **new signature**: trivial for the hot key, a new QR round-trip for a role signer. The extension therefore (a) over-provisions `max_priority_fee_per_gas` for vault txs (+50% over `skandha_getGasPrice`), (b) offers "bump fee" for hot txs after 3 blocks, (c) offers "cancel" = replacement whose body is a single zero-value SENDER frame to self.
- Alt mempool extra: a tx whose VERIFY stops approving is evicted after a bounded number of build attempts (`eip-8141.md:1167`); a `THROTTLED` sender is limited to `THROTTLED_ENTITY_MEMPOOL_COUNT` entries and a `BANNED` sender's pending txs are all removed (`rules/reputation.md` REPUTATION-010/020 `[VERIFIED]`). Devnet sidecar config (probed `skandha_config`): `minInclusionDenominator 10, throttlingSlack 10, banSlack 50, minStake 0.01 ETH, minUnstakeDelay 0`; the draft's values are higher (analysis §1 item 8).
- Role-signer pending txs are shown with a "stuck since N blocks — re-sign on the vault" action; the extension never auto-rebroadcasts a stale vault signature with a different fee (it would be invalid anyway).

---

## 5. The routing engine

### 5.1 Inputs

`{ backend, chainId, action, amountUsd, target, selector, cachedPolicy (cap, bucketUsed, perTxMax, allowlists, sessions, frozen, bunker), mempoolInfo (reachable, staked?, reputation, budgets), roleSignerState (nonce, balance, staked?) }`.

### 5.2 Decision table

| # | Condition | Signer / sender | Mempool | Rule ID shown |
|---|---|---|---|---|
| 1 | `bunker || frozen` | none; show unfreeze/bunker screen | – | `ROUTE-FROZEN` / `ROUTE-BUNKER` |
| 2 | action ∈ {spend, approve-registration, login-sign} and a session policy matches `(target, selector)` with allowance ≥ amount and not expired | hot key + tank key, account sender, `hotExecute` SENDER frame | public | `ROUTE-SESSION-MATCH` |
| 3 | else amount ≤ `perTxMax` and `bucketUsed + amount ≤ cap` and token/target allowlisted | hot key + tank key, account sender, `hotExecute` SENDER frame | public | `ROUTE-HOT-OK` |
| 4 | else amount > remaining cap or not allowlisted | needs vault → §6 | per 6/7 | `ROUTE-NEEDS-VAULT` (+ `CAP-EXCEEDED` / `TARGET-NOT-ALLOWED` / `TOKEN-NOT-ALLOWED`) |
| 5 | admin action (set cap, allowlist, session, rotate hot key, upgrade, migrate, unshield) | vault | per 6/7 | `ROUTE-ADMIN` (+ `TIMELOCK-48H` if loosening/large) |
| 6 | vault action and `mempoolInfo.stakedBudget ≥ IPQVerifier.verifyGasEstimate()` and the vault `PQRoleSigner` is staked, `pathAEnabled()` and `ACTIVE` | vault `PQRoleSigner`, PQ in VERIFY (path A), SENDER = `relay(account, roleCalldata)` | **alt** (`eth_sendFrameTransaction`) | `ROUTE-PATH-A` |
| 7 | vault action otherwise | vault `PQRoleSigner`, pinned ECDSA `payerKey` in VERIFY, PQ in `executePQ(0, account, roleCalldata)` (path B) | **public** | `ROUTE-PATH-B` (+ `PRE-Q-DAY-NOTICE`) |
| 8 | recovery action (`recoveryCancel(opId)`, start 7-day vault rotation) | recovery `PQRoleSigner` | as 6/7 | `ROUTE-RECOVERY` |
| 9 | guardian freeze | an ECDSA guardian is a plain EOA sending a type-2 tx to `account.guardianFreeze()` (`10-contracts.md` §10.3.7); the extension does not hold the guardian key, it shows the call to make (or a deep link) and watches for `Frozen`; the `GuardianSigner` frame-tx form is only for a P256/passkey guardian | public | `ROUTE-GUARDIAN-FREEZE` (+ `RATE-LIMIT-7D`) |

The pre-check in rows 3–4 is advisory; the chain enforces the bucket in execution and a wrong guess costs gas-tank funds, not principal (design doc "Over-cap attempts revert in execution"). The UI says so ("if the day's usage changed on another device this may still revert; cost ≤ X from the gas tank").

### 5.3 The "advertised budget" problem `[DESIGN-ADJUSTMENT]`

The design doc says "the extension auto-selects A or B from the mempool's advertised budget". **No such advertisement exists today**: `skandha_config` (probed) returns reputation/staking parameters and a simulation `validationGasLimit: 10000000`, but no per-entity verify budget; the rule text itself is in flux (BUDGET-010: "100,000 … 1,000,000 in the draft. The landing page shows 250,000 and 2,500,000 (TBD)" `[VERIFIED]` `rules/budget.md`; the analysis measured the live sidecar at a flat 100k). Plan:

1. Ship a static `mempools.json` per endpoint `{unstakedBudget, stakedBudget, source, checkedAt}`.
2. At runtime, **measure**: send `eth_estimateFrameTransactionGas` for the path-A tx shape with a dummy ARBITRARY signature; a `BUDGET-010`/out-of-gas style rejection text → budget too low → path B. (The sidecar's rejection strings are parsed by `explainRejection`, `repos/hegota-support/src/rpc/rejection.ts:9-13`, which today only knows `OP-011` and `STO`; we extend the regexes.)
3. Propose in the sidecar PR (design doc "submit a sidecar PR implementing BUDGET-010 staked budgets") that `skandha_config` gains `budgets: {unstaked, staked}` — the extension reads it when present.

### 5.4 Failure handling

| Failure | Detection | Extension behaviour |
|---|---|---|
| Alt mempool rejects: banned opcode / storage rule | error text matches `OP-011` / `STO` families (`rejection.ts`) | show rule + "this account version cannot use the alt mempool"; fall back to path B if the action allows |
| `THROTTLED` / `BANNED` role signer | sidecar error text (`reputation` family) or explorer API `skandha_explorer_*` | show reputation state; for banned: route to public (path B) and warn that stake can be withdrawn after `unstakeDelay` |
| Stuck hot tx | no receipt after N blocks | bump fee (+10%) or cancel |
| Stuck vault tx | same | "re-sign on vault" (new nonce-bound request), never auto-rebroadcast |
| Over-cap revert | frame receipt body status `0x0` with the account's `OverCap(uint256 requested, uint256 available)` error selector (`10-contracts.md` §10.3.2; `OverCapRejected` is *not* emitted on revert) | update `bucketUsed` from chain via `getBucket()`, show "gas tank charged X" |
| Node unreachable | `RPC_UNREACHABLE` | try the next endpoint for that chain; Anon-RPC worker `ready` rejection → fall back to direct RPC only with explicit user consent (§9.6) |
| SW killed mid-flow | pending request in `storage.session` without a result | re-open the approval window; txs already signed but not submitted are stored as raw bytes and re-submitted on resume |

---

## 6. The vault flow from the extension side

### 6.1 Building the unsigned request

**The UR vocabulary is owned by the companion section** (`20-pq-crypto-vault.md` §4.2): `ur:leaked-sign-request` and `ur:leaked-signature`, CBOR maps with integer keys. The previous draft of this section defined a divergent `VaultRequest`/`ur:leaked-request`/`ur:leaked-response` schema; it is replaced by §20's, reproduced here with the two additions this section needs (keys 10–11, both advisory):

```
ur:leaked-sign-request  (CBOR map; keys 1–9 from 20-pq-crypto-vault.md §4.2)
  1: request-id  uuid                  2: chain-id  uint
  3: tx-type     uint  (6 = EIP-8141 frame tx; 1 = ERC-4337 PackedUserOperation)
  4: unsigned-payload bytes  (frame tx: the RLP preimage of compute_sig_hash, every empty-msg
                              signature replaced by its length placeholder, per the chain's codec profile)
  5: role        uint (1 vault, 2 recovery, 3 guardian)   6: scheme-id bytes32 (IPQVerifier.schemeId, canonical bytes32)
  7: sig-index   uint   8: expected-pk bytes32   9: origin text
 10: profile-id  text  (which @leaked/frames profile encoded field 4: eip8141-current | ethrex-eip8141-tracer | ethrex-hegota-devnet)  — PROPOSED addition
 11: intent      map   { action, summary, erc7730-ref }  — PROPOSED, advisory only; the device MUST ignore it for display (§20 §4.3 item 4 accepts no labels from the request)

ur:leaked-signature
  1: request-id uuid   2: scheme-id bytes32   3: witness bytes (3,688 B for C13)   4: payer-sig bytes .size 65 (path B only)
```

The device decodes field 4 itself, recomputes `compute_sig_hash` and clear-signs (analysis F10; the hegota-demo's whole point is that a browser-side description can lie, `repos/hegota-demo/README.md`). Key 10 is needed because the devnets and the EIP text disagree on the RLP layout (§4.1) and the companion's pinned `@leaked/frames` must select the same profile. The request is wrapped as a BC-UR using `UrFountainEncoder` with `maxFragmentLength` tuned to ~400 bytes (QR version 20–25 at medium error correction) `[UNVERIFIED]` — verification step: measure frames-to-complete with a MacBook webcam and a phone screen at 400/600/800-byte fragments; the analysis estimates ~35 frames and 30–90 s for a 13 KB PORST signature, and ~¼ of that for SPHINCS- C13 (3.7 KB).

### 6.2 Where the QR display and camera live `[DESIGN-ADJUSTMENT]`

- **Display**: the full-tab `app.html` (not the 600×800 popup, which closes on focus loss); animated QR via `qrcode`.
- **Scan**: the same `app.html` page calls `navigator.mediaDevices.getUserMedia({video})`. An **offscreen document cannot be the scanner**: it has no visible surface for the user to aim the camera, and the `USER_MEDIA` reason exists for processing streams, not for UI (`[VERIFIED]` reason list; Chrome's docs make no statement about camera UX in offscreen docs). Whether Chrome shows the extension-origin camera permission prompt from a tab-hosted extension page and remembers it is `[UNVERIFIED]`; verification step: a 20-line probe extension on Chrome stable and the oldest supported version; fallback inputs are (a) paste the UR text, (b) upload a screenshot/PNG decoded with `zxing-wasm`.
- Decoding runs in a Web Worker inside `app.html` (zxing-wasm; `'wasm-unsafe-eval'` is in our CSP `[VERIFIED]`), feeding `UrFountainDecoder.receivePartUr` until `isComplete()`.
- Response UR: `ur:leaked-signature` (§6.1; `{request-id, scheme-id, witness, payer-sig?}`); the extension verifies the witness against the role signer's `pk()` (read from chain via Anon-RPC; `verifier()` gives the scheme) and, on path B, recovers `payer-sig` to `payerKey()` before broadcast (§4.3).

### 6.3 Path selection happens before the QR

Because path A and path B produce different unsigned txs (ARBITRARY entry in VERIFY vs ECDSA payer + PQ in execution), the Router (§5) picks the path first, shows it with the rule ID, then renders the request. If the user switches path after the device signed, a new request is generated with the same role-signer nonce (the first signature was never broadcast); the device will sign it (its C13 counter is a budget counter, not a nonce ledger, §4.5), so the extension must **discard** the first `ur:leaked-signature` and never hold two valid signatures for one `(sender, nonce)`.

### 6.4 Timelock queue UI

Pending vault actions (queued > threshold, cap/allowlist loosening, upgrades; default 48 h, design doc) are read from the account's `Queued(opId, kind, eta)` / `UpgradeQueued` / `MigrationQueued` events and the `isQueued(bytes32)` view (`10-contracts.md` §10.3.2; "execute now" = permissionless `executeQueued(opId, calls)`, cancel = `recoveryCancel(opId)` or `vaultCancel(opId)`) by the `WatcherController` and listed with: action, queued-at, executes-at, "cancel with recovery key" (opens a RecoverySigner request), "execute now" once matured (hot key may call `execute` if the contract allows; else vault). Tightening actions never appear here (instant).

### 6.5 Watcher alerts

- Source: on-chain events, names per `10-contracts.md` §10.3.2: `Frozen(by, until)`, `Unfrozen`, `Queued(opId, kind, eta)`, `QueueExecuted`, `QueueCancelled`, `HotKeyRotated(old, new)`, `BunkerEnabled()`, `UpgradeQueued`, `MigrationQueued`, `VaultRotationStarted(newVaultSigner, eta)`, `CapUpdated`, `HotExecuted(txSigHash, usdDebited, available)` (there is **no** `CapHit` event: an over-cap attempt reverts without a log, so "cap hits" are derived from body-frame status `0x0` + `OverCap` selector in our own txs and from `getBucket()`), polled every 60 s via `chrome.alarms` (30 s minimum `[VERIFIED]`) through Anon-RPC; optionally the hosted watcher service (infra section) over a WebSocket the user can disable.
- Surface: `chrome.notifications` + badge count; the notification deep-links into `app.html#pending/<id>`. Alerts are persisted so an SW restart does not lose them.

---

## 7. UX screens and key states

| Screen | Key states |
|---|---|
| **Onboarding / create account** | new seed → password → hot key shown; backend choice per chain is automatic; "deploy account" (counterfactual address shown first; deploys on first send via `deploy` frame / 4337 initCode) |
| **Set up vault companion** | pairing QR (device publishes its PQ public key(s) + scheme + payer key) → extension registers `VaultSigner` with a hot-key tx only if the account is fresh (otherwise it is a vault-signed rotation); states: no-vault (warning banner: "unlimited hot account", caps disabled), paired-unregistered, registered |
| **Set up recovery and guardian** | recovery root QR import (required before bunker is enabled, design doc); guardian = any address (ECDSA allowed) with 7-day rate limit shown; states: none / set / rotation-in-progress (7-day countdown) |
| **Home** | balance per chain, "today's cap: used/left", frozen/bunker banners, pending vault actions count, watcher alerts, backend badge (`frame` / `4337`) |
| **Send** | recipient (address book, ENS via Anon-RPC reads), token, amount → live route preview with rule ID → approve → activity row with per-frame statuses |
| **Dapp approval** (notification window) | connect / transaction / batch / sign-typed-data (classification shown) / session-policy request; cap impact; route; "reject" / "approve"; "needs vault" turns the button into "create vault request" |
| **Cap and allowlist** | current cap (USD), per-tx max, token and target allowlists, login-domain allowlist; edits create vault requests; loosening shows the 48 h timelock, tightening is instant |
| **Session policies** | list `(target, selector, allowance left, expiry)`; "revoke" is instant (hot); "new" needs the vault; dapp-originated 7715 requests appear here pending |
| **Pending vault actions** | the timelock queue (§6.4); recovery-cancel action |
| **Bunker** | explain; requires recovery root; "activate" (vault request); while active: hot tier disabled, only "install new hot scheme" (vault) |
| **Privacy** | Privacy Pools balance via the Kohaku plugin; shield (hot or vault per cap), unshield (**vault-approved only in v1**, design doc); Anon-RPC status per account |
| **Settings** | auto-lock, Anon-RPC on/off + worker choice, mempool endpoints (read-only list, with "stake status" per role signer), export public account descriptor, danger zone (reset) |
| **Activity** | per tx: route, mempool, frames with status/gas, replacement history; for userOps: bundler + userOpHash + tx hash |

---

## 8. Multi-chain

| Chain | Backend | Mempools | Profile | Status |
|---|---|---|---|---|
| Alt-mempool devnet, chain **1337** | F | public (ethrex `altmempool.forshtat.com`) + alt (`altmempoolgateway.forshtat.com/rpc`, `altmempool.forshtat.com/rpc`) | `ethrex-eip8141-tracer` | `[VERIFIED]` live 2026-11-06 |
| Hegotá devnet, chain **3151908** (`ethrex hegota-devnet`, explorer `dora.hegota.ethrex.xyz`) | F | public only | `ethrex-hegota-devnet` | `[VERIFIED]` profile exists; RPC URL `[UNVERIFIED]` — verification step: find the endpoint in `ethpandaops/bogota-devnets/network-configs` or ask the EF Access Layer team |
| Sepolia 11155111, Mainnet 1 | U | 4337 bundlers (Pimlico/Alto; Kohaku's own repo pulls `@pimlico/alto` 0.0.20 as a dev dep `[VERIFIED]` `repos/kohaku/package.json`) | – | mainnet after audit |
| Hegotá Sepolia fork / mainnet | F | public + a staked ERC-8421 sidecar (infra section) | `eip8141-current` (re-pinned to the fork's final encoding) | 2027+, kill criterion 1 in the analysis |

**Same address across chains and backends — `[DESIGN-CONFLICT with 10-contracts.md]`.** The previous draft assumed one implementation that is both an ERC-7579 account and an ERC-8286 frame account, giving identical initcode and therefore one CREATE2 address on both chain families (ERC-8286 lets a *module* serve both validator targets, type ids 1 and 11 — the 11 is marked `<!-- TBD -->` — `[SPEC-DRAFT]` `repos/ercs/ERCS/erc-8286.md:61-65`). The contracts section does **not** plan that: backend A is `LeakedAccountImpl` behind an ERC1967 proxy from `AccountFactory.createAccount(salt, implementation, initData)`, while backend B is a **third-party 7579 host** (Safe7579 / Kernel v3 / reference MSA) with `LeakedHotValidator` + `LeakedPolicyHook` + `LeakedRoleExecutor` installed (`10-contracts.md` §10.2.1, §10.4). Different initcode ⇒ different addresses. Canonical proposal: the extension keys accounts by `(chainId, backend)` and shows one address per chain family; same-address-everywhere becomes a later option only if contracts decide to ship `LeakedAccountImpl` as its own 7579 host (reported to the plan owner). The CREATE2 salt scheme (`keccak(hotKey, vaultRoot, recoveryRoot, version)`) still gives a deterministic address *within* each family. The role senders (`VaultSigner` etc.) are also CREATE2 with the same salt scheme. Counter-argument we accept: EIP-8141's "deploy new account" prefix uses a `deploy` DEFAULT frame to a factory such as the EIP-7997 predeploy (`eip-8141.md:964`), so on 8141 chains the first tx is `[deploy, self_verify, user_op]`; the factory must be the same address on both chain families for the address to match — if EIP-7997 lands at a predeploy address that does not exist on 4337 chains, we deploy our own CREATE2 factory on both instead and never use the predeploy. This is a contracts-workstream interface (§12).

---

## 9. Security hardening

1. **Origin binding.** Every dapp request is attributed by `MessageSender.origin` in the SW; the inpage script's claims are ignored. SIWE `domain` must equal that origin (EIP-4361 check) before path (a) signing.
2. **Phishing.** Bundled blocklist (`eth-phishing-detect` 1.2.0 exists on npm but is licensed **DBAD**, not MIT `[VERIFIED]` npm — use its *data* only, or MetaMask's list, and check the data license with counsel; `@metamask/phishing-controller` 10.1.1 exists, latest is 18.3.0) refreshed from the extension's own release channel only (no remote code, data is allowed `[VERIFIED]` RHC policy); Ambire's `suspiciousHostingDomains.ts` as a reference list. Warn, never block silently.
3. **Clear signing.** ERC-7730 descriptors (Draft `[SPEC-DRAFT]` `erc-7730.md`) bundled for the allowlisted protocols; the vault device re-decodes independently (analysis F10 "Bybit-style display attack"). Admin actions get a red "admin action" banner on both sides.
4. **Malicious dapps vs the hot key.** Bound by design: per-tx max + rolling cap + allowlists enforced on-chain; `eth_sign` and blind hash signing are not offered (§3.2); unknown typed data is never signed (§3.4 rule 3); `wallet_addEthereumChain` is refused so a dapp cannot point us at a lying RPC.
5. **CSP / supply chain.** `extension_pages` at Chrome's minimum (`'self'` + `'wasm-unsafe-eval'`); no remote code; `npm ci` with a lockfile, `--ignore-scripts`, and a pinned dependency allowlist (viem, noble/scure, wxt, react, zustand, bc-ur, zxing-wasm, anon-rpc harness, Kohaku packages); SLSA-style reproducible build with the Web Store zip hash published in the repo (fits the CROPS "prove the shipped extension matches the public repo" idea in `prizes.txt`). Only the sandboxed anon-rpc page gets `'unsafe-eval'`, and it runs hash-pinned code at a null origin (`[VERIFIED]` anon-rpc SPEC §4, §6).
6. **Anon-RPC for reads.** `@anon-rpc/browser-extension-harness` runs the sandboxed iframe inside **our** offscreen document (its README covers "If your extension already has an offscreen document" `[VERIFIED]`); `worker.fetch` is handed to a viem `custom` transport; `anonOptions: { isolationKey: accountAddress }` per account (design doc "per-account isolation"; `[VERIFIED]` `docs/integrate-wallet.md` "Per-call options" — "Support varies"). Bootstrap read of the specifier contract goes through the user's chosen plain RPC once (`[VERIFIED]` trust model). Live networks (`repos/anon-rpc/adopters.json5` `[VERIFIED]`): tor-js `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e` (mainnet; "Demonstration gateway only … may disappear at any time"), Nym `0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0` (mainnet, ~18 MB bundle), Nox `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A` (Sepolia, chainId 11155111), passthrough `0x4fd77be300f31c5fe6ab266d35d27750a3478d27`. The devnet chain 1337 has no anon worker: reads there go direct and the UI says so. Writes (`eth_sendRawTransaction`, `eth_sendFrameTransaction`) are also routed through the worker when enabled — the worker "sees every request routed through it (including signed transactions before broadcast)" `[VERIFIED]`, which is already true of any RPC provider.
7. **Extension update policy.** Chrome Web Store auto-updates; there is no user-side version pinning (`[VERIFIED]` NOT FOUND on the update page) but developers can roll back and do partial rollouts above 10k 7-day-active users. Our policy: every release is tagged, reproducible, with a changelog line per permission change ("when an update requires additional permissions, users will be prompted" `[VERIFIED]`); security releases are the only ones allowed to touch the signing or routing code paths without a 7-day canary.
8. **Threat model statement (hot-key-loss bound).** Assume the browser profile, the extension process, or the seed phrase is compromised. The attacker can: spend up to the remaining daily cap to allowlisted targets, sign logins for allowlisted domains, use existing session policies, and burn gas-tank funds with over-cap attempts (analysis §1 item 6). The attacker cannot: raise caps, change allowlists, rotate the hot key, unshield, or stop the vault/recovery from rotating them out (separate sender contracts, F2). What the extension therefore must guarantee is only: (i) no PQ key material in the browser, (ii) the vault request bytes shown to the device are the bytes broadcast (the device re-derives the hash), (iii) policy pre-checks never *loosen* what the chain enforces.

---

## 10. Test plan, milestones, dependencies

### 10.1 Tests

| Level | Scope | Tooling |
|---|---|---|
| Unit | `@leaked/frames` codec per profile with pinned vectors (the prototype's PORST tx hash and the workshop's `self_relay` tx as fixtures), sig-hash elision rules, typed-data classifier (every schema in the registry + adversarial variants), router decision table (property-tested), keyring (scrypt params, GCM tamper), UR encode/decode round trips at every fragment size | vitest |
| Contract-in-the-loop | account + role-signer ABIs via anvil forks (4337 path: Alto bundler locally; frame path: the public devnet, or a local `ethrex eip8141-tracer` + sidecar from `repos/mempool-workshop-sidecar/deploy/devnet`) | vitest + viem |
| Extension e2e | Playwright `chromium.launchPersistentContext(userDataDir, {channel:'chromium', args:['--disable-extensions-except=…','--load-extension=…']})`, service worker via `context.serviceWorkers()` / `waitForEvent('serviceworker')` (`[VERIFIED]` playwright.dev/docs/chrome-extensions); scenarios: onboarding, connect via 6963 on a local test dapp, hot send on devnet 1337 (public), batch via `wallet_sendCalls`, over-cap → needs-vault, vault QR round trip with a **simulated device** (a Playwright page that scans the animated QR from a screenshot and answers with a signed UR), SW-kill-and-resume (`serviceWorker.evaluate(() => self.close())` mid-approval) | `@playwright/test` 1.64.1 |
| Dapp compatibility matrix | run against production frontends with the 4337 backend on Sepolia and the frame backend on devnet (where the dapp can be pointed at it): **Uniswap** (swap with Permit2 → path b registration; must confirm Uniswap's interface calls 1271 for contract wallets), **Aave** (approve + supply; `wallet_sendCalls` batch), **OpenSea/Seaport** (listing = typed data → registration; fulfil = tx), **SIWE** (login.xyz demo, Snapshot vote → path a 7739; `[UNVERIFIED]` that `siwe`-based backends verify via 1271 — verification step: run spruceid's `siwe` `verify` against a contract wallet with `provider`), **CoW Swap** (1271 pre-signed orders), **ENS app** (set records), **Safe{Wallet} as a dapp** (sign as owner → 7739). Each cell records: works / works-with-vault / unsupported + reason. | manual + recorded Playwright |
| Devnet e2e | nightly job: hot send public, hot send alt (expect rejection if the VERIFY reads disallowed storage), path-B vault tx, path-A vault tx on the staked sidecar, cancel/replace, throttled-signer scenario via `debug_bundler_setReputation` (admin method `[VERIFIED]` `rpc-methods.md`) | GitHub Actions |

### 10.2 Milestones (2 engineers; person-weeks are effort, not calendar)

| M | Deliverable | pw | Depends on |
|---|---|---|---|
| M0 | WXT scaffold, manifest, keyring, popup/app/approve pages, inpage + 6963, read-only balances via Anon-RPC on Sepolia, Playwright harness | 2.5 | – |
| M1 | `@leaked/frames` (3 profiles, vectors), FrameEngine: build/estimate/sign/submit public + alt, status + receipts, replacement; hot send on devnet 1337 end-to-end with the probe wallet | 4 | contracts: account VERIFY ABI + measured hot VERIFY gas |
| M2 | 4337 backend: viem account-abstraction + permissionless, 7579 account with the policy module, `eth_sendTransaction` / `wallet_sendCalls` / `getCallsStatus` on Sepolia | 4 | contracts: 7579 module + factory addresses |
| M3 | Scoped 1271: 7739 personal_sign + typed-data classifier + hash registration; dapp matrix round 1 | 3 | contracts: `registerHash` ABI, 1271 marker format |
| M4 | Vault flow: request/response schema, BC-UR + camera page, path A/B router with measured budgets, signature pre-verification, timelock queue, watcher alerts | 4 | crypto: scheme ids, sig lengths, TS verifier; device app's UR vocabulary |
| M5 | Session policies (7715 mapping, Smart Sessions on U), cap/allowlist/login-domain screens, bunker, recovery, guardian flows | 3 | contracts: policy structs/events |
| M6 | Privacy tab via Kohaku plugin host (vault-approved unshield), Anon-RPC per-account isolation + settings | 2 | privacy: plugin host adapter, PoolPayer frame shape |
| M7 | Hardening (phishing list, 7730 descriptors, reproducible build), full dapp matrix, devnet nightly, Web Store packaging, docs | 3 | – |
| **Total** | | **≈ 25.5 pw ≈ 6 person-months** | consistent with the analysis's 10–16 pm for the whole v4 |

---

## 11. Open risks and verification steps

| # | Risk | Severity | Verification step |
|---|---|---|---|
| R1 | **EIP-8141 encoding drift** (2-item `fees` with a total `max_fee`, length-committing sig hash) vs the devnets; a Hegotá fork may change again | High | Profiles + vectors (§4.1); re-pin a profile per devnet release; watch `ethereum/EIPs` `eip-8141.md` commits weekly |
| R2 | **No advertised verify budget**; the live sidecar is a flat 100k and path A has no home until BUDGET-010 staked budgets ship | High | §5.3 measurement; sidecar PR; kill criterion 2 in the analysis |
| R3 | Camera access from an extension tab page (prompt behaviour, persistence) | Medium | Probe extension on Chrome stable (§6.2); paste/upload fallbacks |
| R4 | `world: "MAIN"` static content-script minimum Chrome version | Low | Check on the oldest supported Chrome; fallback inline injection |
| R5 | ERC-7739 adoption by dapps/backends (SIWE verifiers calling 1271 with the wrapped signature) | Medium | Matrix cell "SIWE"; test spruceid `siwe` + `viem.verifyMessage` with a 7739 account |
| R6 | Value-bearing registration breaks dapps that expect an ECDSA-recoverable signature (off-chain order books that `ecrecover`) | Medium | Matrix cells OpenSea/CoW/1inch; document as unsupported where true |
| R7 | viem #5165 merges with an API that differs from `@leaked/frames` | Low | Adapter layer; our profile type is the stable interface |
| R8 | Rhinestone `@rhinestone/sdk` session-enable with a contract-signed (vault) enable signature | Medium | §3.7 verification step |
| R9 | Hegotá devnet (3151908) RPC endpoint and whether the public mempool there accepts type-0x06 from arbitrary senders | Medium | Find the endpoint; send the workshop's `self_relay` tx |
| R10 | Anon-RPC worker availability on testnets (only Nox on Sepolia today) and latency for polling | Low | Measure `eth_blockNumber` p50 via Nym/tor-js on mainnet; direct fallback with consent |
| R11 | GPL contamination if any Ambire/Kohaku extension code is copied; **and** the Kohaku SDK's license is only a `package.json` field (`privacy-pools`, `provider`) or absent (`plugins`) with no LICENSE file in the repo `[VERIFIED]` | Low / Medium | Policy: reference only for the extension; for the SDK, get a LICENSE file or explicit maintainer confirmation before release (§1.3) |
| R12 | Rolling-cap USD pricing source for the pre-check (the chain uses vault-set prices, design doc) | Medium | Read prices from the account's config, never from an external API, so the pre-check cannot disagree with execution |

---

## 12. Interfaces needed from the other workstreams

**Contracts** (names now taken from `10-contracts.md` §10.11; the earlier draft's `executeFromVault`, `registerHash(hash, budgetUsd, expiry)`, `CapHit`, `PendingAction*`, `CapExceeded` do not exist there)
- Account ABI: `hotExecute(uint256 declaredUsd, Call[] calls)` with `Call{address target; uint256 value; bytes data;}`, `registerHash(bytes32,address,uint256,uint48)`, `clearExpiredFreeze()`, `executeQueued(bytes32 opId, Call[] calls)`, `guardianFreeze()`; vault/recovery entry points reached only through `PQRoleSigner.exec/relay` (`vaultExecute`, `vaultQueue`, `vaultCancel`, `vaultSetHotKey`, `vaultSetCap`, `vaultSetToken`, `vaultSetSession`, `vaultSetDomain`, `vaultEnableBunker`, `vaultQueueUpgrade`, `vaultQueueMigrate`, `recoveryCancel`, …); views `getHotConfig()`, `getBucket() returns (available, lastUpdate, cap)`, `quoteUsd(address,uint256)`, `isQueued(bytes32)`, `eip712Domain()`; events listed in §6.5; custom errors `OverCap(uint256,uint256)`, `NotAllowed(address,bytes4)`, `DeclaredUsdExceeded(uint256,uint256)`, `BunkerNeedsRecovery()`; 1271: empty signature for registered hashes, ERC-7739 envelope otherwise, sentinel `0x7739…` → `0x77390001`.
- `PQRoleSigner` ABI (canonical, `10-contracts.md` §10.11; instances `VaultSigner`, `RecoverySigner`): `verifyFrame(uint256 sigIndex) payable` (the VERIFY frame's data, `sigIndex = 0`), `executePQ(uint256 sigIndex, address target, bytes data)` (path B), `relay(address target, bytes data)` (path A); self-admin `setPayerKey(address)`, `setPathA(bool)`, `setMaxFee(uint256)`, `stake(uint32,uint256)`, `unlockStake()`, `withdrawStake(address payable)` reachable **only** through `executePQ`/`relay` with `target == roleSigner`; views `account()`, `role()`, `pk()`, `payerKey()`, `sigLength()`, `pathAEnabled()`, `verifier()`, `maxFee()`. The account's VERIFY entry is `verifyFrame()` (no args). `IPQVerifier { schemeId() pure → bytes32; sigLength() pure → uint256 (3688 for C13); verifyGasEstimate() pure → uint256; verify(bytes32 pk, bytes32 digest, bytes sig) view → bool, never reverts }`. Signature layout entry 0 = ARBITRARY witness (`msg` empty), entry 1 (path B) = SECP256K1 by `payerKey`; the measured hot VERIFY gas (ceiling 80k) and `IPQVerifier.verifyGasEstimate()` per scheme.
- Factory: `AccountFactory.createAccount(bytes32 salt, address implementation, bytes initData)` / `predictAccount(...)`, `LeakedAccountImpl.initialize(hotKey, vaultSigner, recoverySigner, capUsdPerDay, perTxMaxUsd, maxFeeWeiPerTx, selfPay)`; the backend-B host account + `installModule` calls (§8 conflict).
- ERC-7730 descriptors for every account function.

**Crypto / vault companion**
- Scheme ids and fixed signature byte lengths (SPHINCS- C13, PORST r=256, SLH-DSA-128s), a TS/WASM verifier for each (the extension pre-verifies before broadcast), the public-key encoding the device publishes at pairing.
- The UR vocabulary (`ur:leaked-sign-request`, `ur:leaked-signature`, `20-pq-crypto-vault.md` §4.2; a pairing UR is still undefined there), acceptance of the proposed keys 10–11 (§6.1), the signature-counter semantics, and the device's clear-signing expectations (it trusts no request-supplied labels, §20 §4.3).
- The device signs `TXPARAM_SIG_HASH` directly (`IPQVerifier.verify(pk, digest, sig)` with `digest = compute_sig_hash(tx)`, §20 §2.6); `@noble/post-quantum` 0.7.1's SLH-DSA `prehash` variant `[VERIFIED]` `src/slh-dsa.ts:222,748` is therefore only relevant to the SLH-DSA fallback adapter.
- `@leaked/frames` is the one codec: §20 calls it `@leaked/frametx`; canonical name proposed here is **`@leaked/frames`** (owner: this section), pinned by hash in the companion build.
- An RFC-6979 ECDSA `signTypedData` over QR by the path-B `payerKey` for the Privacy Pools `PrivacyPoolNote` envelope (`40-privacy-infra.md` §1.4): §20's UR has no typed-data request type yet — proposed `tx-type 2` (EIP-712, as in ERC-4527) with the typed data in field 4.

**Privacy / infra**
- Kohaku plugin host adapter contract (`Host = {network, storage, keystore(deriveAt), provider, externalSyncProvider?}` `[VERIFIED]` `repos/kohaku/packages/plugins/src/host/index.ts:10-21`, README `:55-61`) and which `scopeKeystore` path the vault owns; the PoolPayer frame layout for unshield txs (`40-privacy-infra.md` §2.2) — note it needs the LEAKED account's hot VERIFY to admit a shape (`[expiry?, only_verify(self), pay(PoolPayer), DEFAULT(PoolPayer.settle), SENDER*, DEFAULT(PoolPayer.refund)]`) that `10-contracts.md` §10.5.1 step 6 currently rejects (no DEFAULT frames, SENDER only to self): a contracts-section ask, not something the extension can work around; the staked sidecar endpoint and its `skandha_config` budget fields; the watcher service's WebSocket/HTTP API and alert schema; the Anon-RPC worker/specifier choice per chain.

---

## Verification log (independent re-check, 2026-11-06)

Sources re-opened: `repos/eips` @ af5ea76, `repos/ercs` @ 7dafd11, ERC-8421 `pr-clean` (380 lines), `repos/kohaku-extension` @ 72922ab, `repos/ambire-common` @ ab6337f, `repos/kohaku` @ 39ba1bd, `repos/anon-rpc` @ c8980fb, `repos/bc-ur` @ 428b039, `repos/noble-post-quantum` @ 48e4933, `repos/smartsessions` @ f5aaf86, sidecar @ 2e22ff0, hegota-support @ 2377188, workshop @ bcfe02a, npm registry, GitHub API (viem/wxt/licenses), developer.chrome.com, playwright.dev, live probes of `altmempool.forshtat.com{,/rpc}` and `altmempoolgateway.forshtat.com/rpc`. Counts for this file: 96 claims checked, 71 confirmed as written, 19 corrected, 6 downgraded/added as `[UNVERIFIED]`.

### Changes (old → new, source)

1. §1.1 README line `:9` → `:10`; webpack entries `:346-353` → `:346-359` (+`main`, Gecko-only injection entries); size "112,155 lines" → "~113,000"; `privacyPools` "7,374 lines" → "≈3,400 excl. 3,947-line test"; keystore controller cite `controllers/keystore/keystore.ts:158-180` (that is a doc comment) → migration at `libs/keystore/keystore.ts:363-445`; `pimlico_getUserOperationGasPrice` is in `pimlico.ts:42,46`, not the three named drivers; pq-account gas "8.4M" → "8.40M" (`README.md:71-73`). *Source: the clones.*
2. §1.1 **Provider injection — WRONG**: Ambire does use `world: 'MAIN'` on Chromium (dynamic `chrome.scripting.registerContentScripts`, `handleScripting.ts:40,52,62`); the inline `<script>` path is Firefox < 128 only (`webpack.config.js:354-368`). §2.1 fallback rewritten accordingly (Chrome 102+ for dynamic `world`, static manifest `world` still `[UNVERIFIED]`).
3. §1.1 "Supported dapp RPC whitelist" → an `RpcMethods` enum that is **not enforced** (`RPCMethod = … | string`, `providerRequestTransport.ts:31`).
4. §1.3 Rabby README has no `notification.html` subsection (`README.md:61-97`); **Kohaku SDK "MIT"** → MIT only as a `package.json` field for `privacy-pools`/`provider`, **no LICENSE file in the repo, no license field in `@kohaku-eth/plugins`** (npm license empty) → caveat + R11 widened.
5. §1.4 `@rhinestone/sdk` → `getEnableSessionDetails`/`encodeSmartSessionSignature({mode,…})` exist only in `@rhinestone/module-sdk` 0.4.0; `@rhinestone/sdk` 3.2.0 has a different `encodeSmartSessionSignature(signers, validatorSignature)` and no enable helper (npm tarballs). Policies list + `ArgPolicy/`. bc-ur: pin 2.0.0-beta.9 (npm `latest` 1.1.13 lacks the fountain API; §20 pins beta.9). `jsqr` is Apache-2.0.
6. §2.3 "`target: 'offscreen'` is the anon-rpc harness pattern" → **NOT FOUND** in the harness README; it uses `mountOffscreenHost()` + `offscreenUrl: false` (`README.md:113-150`). Single shared offscreen document now stated as the contract with §40.
7. §2.4 added the tank key (§10's default hot shape needs a second extension-held EOA) at `m/44'/60'/1'/0/k`.
8. §3.1 5792 error table `:384-392` → `:387-393`, added `5760`; `wallet_switchEthereumChain` → `4902` for unknown chain (EIP-3326 defines no code; MetaMask convention).
9. §3.2 `eth_sendTransaction`/`wallet_sendCalls` hot shape `[self_verify, SENDER×n + ATOMIC_BATCH_FLAG]` → **`[only_verify(account, verifyFrame()), pay(tank EOA), SENDER(account, hotExecute(declaredUsd, calls[]))]`** per `10-contracts.md` §10.2.2/§10.5.1 (the walker admits only `hotExecute` SENDER frames to self); app-supplied `id` must be honoured (`eip-5792.md:74-78`); 7715 method set completed with `wallet_getSupportedExecutionPermissions` (`erc-7715.md:209`); 7739 PersonalSign cite `:69` → `:218-229`, TypedDataSign `:71-207` → `:71-213` (layout `:175`).
10. §3.4 registration marker `bytes4 ‖ hash` → **empty signature** per §10.11 (`registerHash(bytes32,address,uint256,uint48)` inside `hotExecute`), with a `[UNVERIFIED]` dapp-compat risk and fallback.
11. §4.1 viem PR statuses made exact (#4486/#5118 closed unmerged; #5119/#5121/#5158 merged into `jxom/*` feature branches; #5165 open, base `main`); **`ox` 1.8.13 ships `TxEnvelopeEip8141`** (new, `[UNVERIFIED]` which revision).
12. §4.2 rewritten: `self_relay` is not an identifier (`eip-8141.md:964-970`); flag name `APPROVE_EXECUTION_AND_PAYMENT`; `eip-8141.md:260` → `:261`; path-B shape (PQ sig in calldata, SENDER to `account.executeFromVault`, payer at sig index 0) → §10's `[VERIFY(roleSigner, 0x3, verifyFrame(0)), SENDER(roleSigner, executePQ(0, account, data))]` with entry 0 = ARBITRARY witness, entry 1 = SECP256K1 `payerKey`; path A SENDER = `relay(account, data)`; C13 "3.7 KB" → 3,688 B; VERIFY frame data must be `verifyFrame()`/`verifyFrame(0)`, never `0x` (§10.3.2 `receive()` note).
13. §4.5 role-signer names → `PQRoleSigner` instances; "device write-ahead counter refuses a repeated nonce" → not promised by §20 (C13 keeps a budget counter) — extension tracks `(sender, nonce, sigHash)`. §4.6 per-frame status cite `:244` + `:879`.
14. §5.2 rows 2–3 add the tank key / `hotExecute`; rows 6–8 canonical selectors; row 9 ECDSA guardian = plain EOA type-2 tx (`10-contracts.md` §10.3.7). §5.4 `CapExceeded` → `OverCap(uint256,uint256)`.
15. §6.1/§6.2/§6.3 `VaultRequest`/`ur:leaked-request`/`ur:leaked-response` → §20's `ur:leaked-sign-request`/`ur:leaked-signature` (integer keys, `scheme-id bytes32`), with proposed keys 10 (`profile-id`) and 11 (advisory `intent`); `pqRoot()` → `pk()`; path-switch note corrected.
16. §6.4/§6.5 events → §10.3.2 names (`Queued`, `QueueExecuted/Cancelled`, `Frozen(by, until)`, `BunkerEnabled`, `UpgradeQueued`, `MigrationQueued`, `VaultRotationStarted`, …); `CapHit`/`PendingActionQueued`/`BunkerActivated` do not exist.
17. §8 "same address on both backends via one 7579+8286 implementation" → `[DESIGN-CONFLICT]`: §10 uses `LeakedAccountImpl` (A) vs third-party 7579 hosts + modules (B); proposal: key accounts by `(chainId, backend)`. ERC-8286 cite `:59-65` → `:61-65` (type id 11 is `<!-- TBD -->`).
18. §9.2 `eth-phishing-detect` is **DBAD**-licensed (npm), not MIT; `@metamask/phishing-controller` latest 18.3.0. §9.6 adopters now cite `adopters.json5` lines; Nox specifier `0x3513…7A9A` added.
19. §12 contracts/crypto/privacy interfaces rewritten to the canonical `10-contracts.md` §10.11 / `20-pq-crypto-vault.md` §2.6/§4.2 names (`IPQVerifier`, `PQRoleSigner.verifyFrame/executePQ/relay`, self-admin only via `executePQ`/`relay`, views incl. `pk()`, `maxFee()`); `@leaked/frames` proposed as the one codec name (§20 says `@leaked/frametx`); typed-data UR `tx-type 2` proposed for the Privacy Pools envelope.

### Confirmed (brief)

EIP-8141 @ af5ea76: payload/fees `:66-90`; sig schemes `:216-232, 289-299`; sig-hash length commitment `:248-262`; no tx-level receipt status `:246`; `SIGPARAM_RESOLVED_SIGNER :892`; policy summary `:945-956`; structural rules `:1015-1028`; `(sender, nonce)` alternatives `:1159`; 10 % replacement `:1161`; eviction `:1167`; `MAX_FRAMES 64 :42`; `ATOMIC_BATCH_FLAG 0x4 :131`; `MAX_VERIFY_GAS 100_000 :933`; linear nonce only; EIP-7997 row is `:965` (not 964). EIP-6963 `:46-163`; EIP-1193 codes `:149-156`; EIP-5792 `atomicRequired:false` `:64-67`, status codes `:214-218`; ERC-4337 `:264`; ERC-7846/7836 method names; ERC-7730 Draft. EIP-8250 `MAX_NONCE_KEYS 16`. Kohaku-extension/ambire-common: GPL-3.0, package versions, `isMetaMask = true :103`, rdns `:141`, manifest permissions/host_permissions/`externally_connectable`, scrypt params `:28`, no `installModule`, contracts list, e2e dir, 125,689 lines. MetaMask 10,000-MAU clause; Rabby MIT. npm: every pinned version exists (wxt 0.21.5, zustand 5.0.16, react-query 5.106.1, viem 2.57.16, ox 1.8.13, permissionless 0.5.2, noble/scure 2.4.0, post-quantum 0.7.1, eth-sig-util 9.0.0 ISC, qrcode 1.5.4, zxing-wasm 3.1.6, jsqr 1.4.0, anon-rpc harness 0.4.0, playwright 1.64.1, hegota-support 0.0.1 MIT); wxt 10.7k stars pushed 2026-11-05. viem `account-abstraction` actions and `toSmartAccount`; permissionless `actions/smartAccount/*`. `slh_dsa_shake_128s` (`:860`, range 853-888) and `prehash`. Chrome docs: SW 30 s / 5 min / 109-120 bullets; `storage.session` 10 MB (1 MB ≤ Chrome 111), in-memory, `setAccessLevel`; `storage.local` 10 MB (5 MB ≤ 113) + `unlimitedStorage`; offscreen 109+, one at a time, reasons, lifetime only for `AUDIO_PLAYBACK`; CSP minimum and sandbox default; side panel 114+; CWS permission-prompt and 10k-user rollout; Playwright `launchPersistentContext`/`serviceWorkers()`. anon-rpc MIT, SPEC §5/§9.3/§11/§4/§6, `integrate-wallet.md:86-90`, harness manifest/CSP (`blob:` rationale `:88-92`), copy step, SW note, CHANGELOG 0.4.0 breaking, issue #10 ~1.5 s. bc-ur README `:736-898` API. hegota-support profiles/codec/wire/rejection lines; workshop `send.ts:11-29`, `build.ts:44`, `workshop.config.json5:7-10,14,48-50`. Sidecar: `skandha_frameTransactionStatus` enum, `eth_getFrameTransactionReceipt`, `skandha_getGasPrice`, `skandha_subscribe` doc, `FrameTx.ts:33-37, 86-90`, `frameTxReceipt.ts:22`, `interfaces.ts:47-54`, `rejection.ts:9-13`, `rules/budget.md` (incl. 7-key nonce note), `rules/reputation.md`, `rules/lifecycle.md`, `choosing-a-mempool.md:32`, `rpc-methods.md`. Live 2026-11-06: `skandha/v4.1.1-`, `ethrex/v23.0.0-eip8141-tracer-9aa3645d…`, chain `0x539`, `skandha_config` values (no budget fields, `validationGasLimit 10000000`), `-32600 "Frame transaction not found"`, `-32000 "transaction receipt not found"`, `ethrex_simulateFrameTransaction` param error, `rpc_modules` unsupported on both.

"use client";

import { useCallback, useEffect, useState } from "react";
import { parseEther, toHex } from "viem";
import { engine, type EngineEvent } from "@/lib/engine/client";
import { createPasskey, passkeySecret } from "@/lib/passkey";
import type { SignProof } from "@/lib/proof";
import type { NetworkInfo, UiType } from "@/lib/engine/protocol";
import { Btn, Check, Field, LogProvider, Panel, Row, Select, json, list, useRunner, type LogEntry } from "./ui";

/**
 * /test: every wallet feature, one button each, against the real engine (the extension's `Wallet` in a worker) and the
 * real network. For testing flows end to end while the product UI is designed; not a product surface.
 */

const SECTIONS = [
  ["engine", "Engine & network"],
  ["passkey", "Passkey PQ account"],
  ["keyring", "Keyring"],
  ["account", "Account"],
  ["send", "Send (owner)"],
  ["activity", "Activity"],
  ["sessions", "Sessions"],
  ["dapp", "Dapp simulator"],
  ["keys", "Keys & recovery"],
  ["migrate", "Move to quantum-safe"],
  ["privacy", "Private balance"],
  ["leanpool", "LeanPool node"],
  ["raw", "Raw UiApi call"],
] as const;

const UI_TYPES: UiType[] = [
  "state:get",
  "keyring:create",
  "keyring:import",
  "keyring:revealWords",
  "keyring:unlock",
  "keyring:lock",
  "keyring:changePassword",
  "keyring:reset",
  "keyring:createFromPasskey",
  "keyring:unlockWithPasskey",
  "keyring:revealWordsWithPasskey",
  "keyring:passkeyInfo",
  "settings:update",
  "setup:update",
  "wallet:balance",
  "permissions:list",
  "permissions:revoke",
  "approval:get",
  "approval:resolve",
  "approval:preview",
  "account:status",
  "account:setGuardians",
  "account:activate",
  "send:preview",
  "send:submit",
  "activity:list",
  "sessions:list",
  "sessions:create",
  "sessions:revoke",
  "keys:view",
  "keys:prune",
  "keys:cancelRecovery",
  "migrate:preview",
  "migrate:run",
  "privacy:view",
  "privacy:sync",
  "privacy:start",
  "privacy:retry",
  "privacy:cancel",
  "privacy:dismiss",
  "privacy:saveConfig",
  "privacy:connection",
];

const PUBLIC_FAUCET_RPC = "https://altmempoolgateway.forshtat.com/rpc";

const eth = engine;

/** The password typed in the Keyring panel: the engine signs only with the password or passkey sent again. */
let harnessPassword = "";

/** A signing request with its proof: the passkey (a prompt) for a passkey wallet, else the Keyring panel's password. */
async function signed<T extends object>(req: T): Promise<T & { proof: SignProof }> {
  const info = await eth().call("keyring:passkeyInfo");
  if (info)
    return { ...req, proof: { entropy: (await passkeySecret(navigator.credentials, info.credentialId)).entropy } };
  if (!harnessPassword)
    throw new Error("Type the wallet's password in the Keyring panel first: every signature needs it.");
  return { ...req, proof: { password: harnessPassword } };
}
const hex = (s: string) => s.trim() as `0x${string}`;

export function TestHarness() {
  const [boot, setBoot] = useState<"starting" | "ok" | "other-tab">("starting");
  const [network, setNetwork] = useState<NetworkInfo>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [approvals, setApprovals] = useState<string[]>([]);
  const [events, setEvents] = useState<EngineEvent[]>([]);

  useEffect(() => {
    const e = engine();
    const off = e.on((ev) => {
      if (ev.event === "ready") setNetwork(ev.network);
      if (ev.event === "approval") setApprovals((a) => (a.includes(ev.approvalId) ? a : [...a, ev.approvalId]));
      setEvents((x) => [ev, ...x].slice(0, 50));
    });
    void e.start().then(async (s) => {
      setBoot(s);
      if (s === "ok") setNetwork(await e.getNetwork());
    });
    return off;
  }, []);

  const addLog = useCallback((entry: LogEntry) => setLog((l) => [entry, ...l].slice(0, 200)), []);

  if (boot === "other-tab") {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <p className="max-w-md">
          QueueBit is already open in another tab. Close it (or this one): only one tab runs the wallet at a time, so
          the owner key&apos;s signature count is never raced.
        </p>
      </div>
    );
  }

  return (
    <LogProvider value={addLog}>
      <div className="mx-auto grid max-w-[1400px] gap-6 p-4 lg:grid-cols-[200px_minmax(0,1fr)_380px]">
        <nav className="top-4 flex flex-col gap-1 self-start text-[13px] lg:sticky">
          <p className="mb-1 font-semibold">QueueBit /test</p>
          <p className="mb-3 text-[12px] text-muted">
            {boot === "starting" ? "Starting engine…" : network ? `${network.name} · chain ${network.chainId}` : ""}
          </p>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg">
              {label}
            </a>
          ))}
        </nav>

        <main className="flex min-w-0 flex-col gap-4">
          <EnginePanel network={network} onNetwork={setNetwork} />
          <PasskeyPanel />
          <KeyringPanel />
          <AccountPanel network={network} />
          <SendPanel />
          <ActivityPanel />
          <SessionsPanel network={network} />
          <DappPanel approvals={approvals} onResolved={(id) => setApprovals((a) => a.filter((x) => x !== id))} />
          <KeysPanel />
          <MigratePanel />
          <PrivacyPanel />
          <LeanPoolPanel network={network} />
          <RawPanel />
        </main>

        <aside className="top-4 flex max-h-[calc(100vh-2rem)] flex-col gap-3 self-start lg:sticky">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Call log</h2>
            <Btn onClick={() => setLog([])}>Clear</Btn>
          </div>
          <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
            {log.map((l, i) => (
              <li key={`${l.at}-${i}`} className="rounded-md border border-line p-2">
                <p className={`text-[12px] font-semibold ${l.ok ? "text-safe" : "text-danger"}`}>
                  {l.ok ? "✓" : "✗"} {l.label} <span className="font-normal text-muted">· {l.ms} ms</span>
                </p>
                <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted">
                  {json(l.result)}
                </pre>
              </li>
            ))}
          </ol>
          <details className="text-[12px]">
            <summary className="cursor-pointer font-semibold">Engine events ({events.length})</summary>
            <pre className="mt-1 max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">
              {json(events)}
            </pre>
          </details>
        </aside>
      </div>
    </LogProvider>
  );
}

// ---- Engine & network ---------------------------------------------------------------------------------------------

function EnginePanel({ network, onNetwork }: { network?: NetworkInfo; onNetwork: (n: NetworkInfo) => void }) {
  const r = useRunner();
  const [rpcUrl, setRpc] = useState("");
  const [sidecarUrl, setSidecar] = useState("");
  const [leanpoolUrl, setLeanpool] = useState("");
  useEffect(() => {
    void eth()
      .getConfig()
      .then((c) => {
        setRpc(c.rpcUrl ?? "");
        setSidecar(c.sidecarUrl ?? "");
        setLeanpool(c.leanpoolUrl ?? "");
      })
      .catch(() => undefined);
  }, []);
  return (
    <Panel
      id="engine"
      title="Engine & network"
      runner={r}
      hint="The engine is the extension's Wallet running in a Web Worker. Endpoint overrides apply at once (empty: the build's default)."
    >
      {network && (
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
          <dt className="text-muted">RPC</dt>
          <dd className="break-all">{network.rpcUrl}</dd>
          <dt className="text-muted">Sidecar</dt>
          <dd className="break-all">{network.sidecarUrl}</dd>
          <dt className="text-muted">LeanPool node</dt>
          <dd className="break-all">{network.leanpoolUrl}</dd>
          <dt className="text-muted">Pinned aggregator</dt>
          <dd className="break-all">{network.aggregator ?? "— (the node's own)"}</dd>
          <dt className="text-muted">Local devnet build</dt>
          <dd>{String(network.localDevnet)}</dd>
        </dl>
      )}
      <Row>
        <Field label="RPC override" value={rpcUrl} onChange={setRpc} placeholder={network?.rpcUrl} />
        <Field label="Sidecar override" value={sidecarUrl} onChange={setSidecar} placeholder={network?.sidecarUrl} />
        <Field
          label="LeanPool override"
          value={leanpoolUrl}
          onChange={setLeanpool}
          placeholder={network?.leanpoolUrl}
        />
      </Row>
      <Row>
        <Btn
          tone="primary"
          busy={r.busy === "config:set"}
          onClick={() =>
            void r.run("config:set", async () => {
              const n = await eth().setConfig({ rpcUrl, sidecarUrl, leanpoolUrl });
              onNetwork(n);
              return n;
            })
          }
        >
          Save endpoints
        </Btn>
        <Btn onClick={() => void r.run("network", () => eth().getNetwork())}>Network & deployment</Btn>
        <Btn onClick={() => void r.run("state:get", () => eth().call("state:get"))}>state:get</Btn>
        <Btn onClick={() => void r.run("storage:dump", () => eth().dumpStorage())}>Dump storage</Btn>
        <Btn
          tone="danger"
          onClick={() => {
            if (confirm("Delete every key and record in this browser's QueueBit storage?"))
              void r.run("storage:wipe", () => eth().wipeStorage());
          }}
        >
          Wipe storage
        </Btn>
      </Row>
    </Panel>
  );
}

// ---- Passkey PQ account --------------------------------------------------------------------------------------------

/** Asks the faucet (public gateway) for devnet ETH. */
async function askFaucet(faucetRpc: string, address: string) {
  const res = await fetch(faucetRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_faucet", params: [address] }),
  });
  return { address, response: await res.json() };
}

/** The passkey this wallet needs (unlock / reveal ask for it by id). */
async function storedPasskey(): Promise<string> {
  const info = await eth().call("keyring:passkeyInfo");
  if (!info) throw new Error("This wallet has no passkey: create one with the passkey first (or reset the keyring).");
  return info.credentialId;
}

function PasskeyPanel() {
  const r = useRunner();
  const [userName, setUserName] = useState("queuebit-test");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.001");
  const [faucetRpc, setFaucetRpc] = useState(PUBLIC_FAUCET_RPC);
  const status = () => eth().call("account:status", {});
  return (
    <Panel
      id="passkey"
      title="Passkey PQ account"
      runner={r}
      hint="No password, no words to write down: the passkey's PRF output is the wallet's secret, which derives the quantum-safe owner key (leanSPHINCS). Every unlock asks the passkey. Create → Fund → Transfer: the first transfer creates the account on chain, then pays."
    >
      <Row>
        <Field label="Passkey name" value={userName} onChange={setUserName} />
        <Btn
          tone="primary"
          onClick={() =>
            void r.run("passkey:create", async () => {
              const p = await createPasskey(navigator.credentials, { userName: userName.trim() || "queuebit" });
              await eth().call("keyring:createFromPasskey", p);
              const s = await status();
              return { credentialId: p.credentialId, account: s.address, setupKey: s.setupKey };
            })
          }
        >
          Create with passkey
        </Btn>
        <Btn
          onClick={() =>
            void r.run("passkey:unlock", async () => {
              const p = await passkeySecret(navigator.credentials, await storedPasskey());
              await eth().call("keyring:unlockWithPasskey", { entropy: p.entropy });
              return { account: (await status()).address };
            })
          }
        >
          Unlock with passkey
        </Btn>
        <Btn onClick={() => void r.run("keyring:lock", () => eth().call("keyring:lock"))}>Lock</Btn>
        <Btn
          onClick={() =>
            void r.run("passkey:revealWords", async () => {
              const p = await passkeySecret(navigator.credentials, await storedPasskey());
              return eth().call("keyring:revealWordsWithPasskey", { entropy: p.entropy });
            })
          }
        >
          Reveal words (backup)
        </Btn>
      </Row>
      <Row>
        <Btn onClick={() => void r.run("account:status", status)}>Status</Btn>
        <Btn
          tone="primary"
          onClick={() =>
            void r.run("fund", async () => {
              const s = await status();
              if (!s.address) throw new Error(s.error ?? "No account address yet: unlock first.");
              // The account gets the money; until it exists, its setup key also needs a little to create it.
              const account = await askFaucet(faucetRpc, s.address);
              const setupKey = s.deployed ? undefined : await askFaucet(faucetRpc, s.setupKey);
              return { account, setupKey };
            })
          }
        >
          Fund (faucet)
        </Btn>
      </Row>
      <Row>
        <Field label="Transfer to" value={to} onChange={setTo} placeholder="0x…" />
        <Field label="Amount (ETH)" value={amount} onChange={setAmount} />
        <Btn
          tone="primary"
          onClick={() =>
            void r.run("transfer", async () =>
              eth().call("send:submit", await signed({ to: hex(to), valueWei: parseEther(amount.trim()).toString() })),
            )
          }
        >
          Transfer (creates the account first if needed)
        </Btn>
      </Row>
      <Field label="Faucet (gateway RPC)" value={faucetRpc} onChange={setFaucetRpc} wide />
    </Panel>
  );
}

// ---- Keyring ---------------------------------------------------------------------------------------------------

function KeyringPanel() {
  const r = useRunner();
  const [password, setPasswordState] = useState("");
  const setPassword = (v: string) => {
    harnessPassword = v;
    setPasswordState(v);
  };
  const [newPassword, setNewPassword] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [reveal, setReveal] = useState(true);
  return (
    <Panel
      id="keyring"
      title="Keyring"
      runner={r}
      hint="24 words → the quantum-safe owner key (leanSPHINCS), the setup key, session keys, the privacy payer. Reloading the page locks it."
    >
      <Row>
        <Field label="Password (8+)" type="password" value={password} onChange={setPassword} />
        <Check label="Return the words on create" checked={reveal} onChange={setReveal} />
      </Row>
      <Row>
        <Btn
          tone="primary"
          onClick={() =>
            void r.run("keyring:create", () => eth().call("keyring:create", { password, revealWords: reveal }))
          }
        >
          Create
        </Btn>
        <Btn onClick={() => void r.run("keyring:unlock", () => eth().call("keyring:unlock", { password }))}>Unlock</Btn>
        <Btn onClick={() => void r.run("keyring:lock", () => eth().call("keyring:lock"))}>Lock</Btn>
        <Btn onClick={() => void r.run("keyring:revealWords", () => eth().call("keyring:revealWords", { password }))}>
          Reveal words
        </Btn>
      </Row>
      <Field label="Backup words (restore)" value={mnemonic} onChange={setMnemonic} area wide />
      <Row>
        <Btn onClick={() => void r.run("keyring:import", () => eth().call("keyring:import", { mnemonic, password }))}>
          Restore from words
        </Btn>
        <Field label="New password" type="password" value={newPassword} onChange={setNewPassword} />
        <Btn
          onClick={() =>
            void r.run("keyring:changePassword", () =>
              eth().call("keyring:changePassword", { oldPassword: password, newPassword }),
            )
          }
        >
          Change password
        </Btn>
        <Btn
          tone="danger"
          onClick={() => {
            if (confirm("Remove the keys from this browser?"))
              void r.run("keyring:reset", () => eth().call("keyring:reset"));
          }}
        >
          Reset keyring
        </Btn>
      </Row>
      <Row>
        <Btn
          onClick={() =>
            void r.run("setup:update", () =>
              eth().call("setup:update", { completedAt: Date.now(), backupConfirmedAt: Date.now() }),
            )
          }
        >
          Mark setup + backup done
        </Btn>
        <Btn
          onClick={() => void r.run("settings:update", () => eth().call("settings:update", { autoLockMinutes: 60 }))}
        >
          Auto-lock 60 min
        </Btn>
      </Row>
    </Panel>
  );
}

// ---- Account -----------------------------------------------------------------------------------------------------

function AccountPanel({ network }: { network?: NetworkInfo }) {
  const r = useRunner();
  const [guardians, setGuardians] = useState("");
  const [threshold, setThreshold] = useState("1");
  const [faucetRpc, setFaucetRpc] = useState(PUBLIC_FAUCET_RPC);
  const [fundAddr, setFundAddr] = useState("");
  return (
    <Panel
      id="account"
      title="Account"
      runner={r}
      hint="The address is computed from the owner key, the aggregator and the guardians (counterfactual until created). Fund the setup key, then activate."
    >
      <Row>
        <Btn tone="primary" onClick={() => void r.run("account:status", () => eth().call("account:status", {}))}>
          account:status
        </Btn>
        <Btn onClick={() => void r.run("wallet:balance", () => eth().call("wallet:balance", {}))}>wallet:balance</Btn>
        <Btn
          tone="primary"
          onClick={() => void r.run("account:activate", async () => eth().call("account:activate", await signed({})))}
        >
          Activate (setup key creates it)
        </Btn>
      </Row>
      <Row>
        <Field label="Guardians (before activation)" value={guardians} onChange={setGuardians} placeholder="0x…, 0x…" />
        <Field label="Threshold" value={threshold} onChange={setThreshold} />
        <Btn
          onClick={() =>
            void r.run("account:setGuardians", () =>
              eth().call("account:setGuardians", {
                guardians: list(guardians).map(hex),
                threshold: Number(threshold),
              }),
            )
          }
        >
          Set guardians
        </Btn>
      </Row>
      <Row>
        <Field label="Faucet (gateway RPC)" value={faucetRpc} onChange={setFaucetRpc} />
        <Field label="Address (empty: the setup key)" value={fundAddr} onChange={setFundAddr} />
        <Btn
          onClick={() =>
            void r.run("faucet", async () => {
              const address = fundAddr.trim() || (await eth().call("account:status", {})).setupKey;
              const res = await fetch(faucetRpc, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_faucet", params: [address] }),
              });
              return { address, response: await res.json() };
            })
          }
        >
          Ask the faucet
        </Btn>
      </Row>
      {network?.localDevnet && (
        <p className="text-[12px] text-muted">
          Local devnet: use the faucet URL from NEXT_PUBLIC_QUEUEBIT_FAUCET_URL, or fund with a devnet key.
        </p>
      )}
    </Panel>
  );
}

// ---- Send ----------------------------------------------------------------------------------------------------------

function SendPanel() {
  const r = useRunner();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.001");
  const req = () => ({ to: hex(to), valueWei: parseEther(amount.trim()).toString() });
  return (
    <Panel
      id="send"
      title="Send (owner)"
      runner={r}
      hint="Signed by the quantum-safe owner key, sent through the LeanPool node (needs a node: see Engine & network)."
    >
      <Row>
        <Field label="To" value={to} onChange={setTo} placeholder="0x…" />
        <Field label="Amount (ETH)" value={amount} onChange={setAmount} />
        <Btn onClick={() => void r.run("send:preview", () => eth().call("send:preview", req()))}>Preview</Btn>
        <Btn
          tone="primary"
          onClick={() => void r.run("send:submit", async () => eth().call("send:submit", await signed(req())))}
        >
          Send
        </Btn>
      </Row>
    </Panel>
  );
}

// ---- Activity ------------------------------------------------------------------------------------------------------

function ActivityPanel() {
  const r = useRunner();
  const [auto, setAuto] = useState(false);
  const { run } = r;
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void run("activity:list", () => eth().call("activity:list")), 3000);
    return () => clearInterval(t);
  }, [auto, run]);
  return (
    <Panel id="activity" title="Activity" runner={r} hint="Pending entries are refreshed by the engine every 30 s.">
      <Row>
        <Btn onClick={() => void r.run("activity:list", () => eth().call("activity:list"))}>activity:list</Btn>
        <Check label="Poll every 3 s" checked={auto} onChange={setAuto} />
      </Row>
    </Panel>
  );
}

// ---- Sessions ------------------------------------------------------------------------------------------------------

function SessionsPanel({ network }: { network?: NetworkInfo }) {
  const r = useRunner();
  const [origin, setOrigin] = useState("https://app.example");
  const [targets, setTargets] = useState("");
  const [perTxEth, setPerTx] = useState("0.01");
  const [dailyEth, setDaily] = useState("0.05");
  const [hours, setHours] = useState("24");
  const [tokens, setTokens] = useState("[]");
  const [revokeId, setRevokeId] = useState("");
  return (
    <Panel
      id="sessions"
      title="Sessions"
      runner={r}
      hint="A key this browser holds that one site may use without a prompt: only the listed contracts, within per-payment and daily limits. Adding/ending one is an owner transaction."
    >
      <Row>
        <Field label="Site origin" value={origin} onChange={setOrigin} />
        <Field label="Allowed contracts" value={targets} onChange={setTargets} placeholder="0x…, 0x…" />
      </Row>
      <Row>
        <Field label="Per payment (ETH)" value={perTxEth} onChange={setPerTx} />
        <Field label="Daily (ETH, 0 = none)" value={dailyEth} onChange={setDaily} />
        <Field label="Hours" value={hours} onChange={setHours} />
      </Row>
      <Field
        label={`Token limits JSON [{token, perTx, daily, decimals}] — tokens on this network: ${network?.tokens.map((t) => `${t.symbol} ${t.token} (${t.decimals})`).join(", ") || "none"}`}
        value={tokens}
        onChange={setTokens}
        area
        wide
      />
      <Row>
        <Btn onClick={() => void r.run("sessions:list", () => eth().call("sessions:list", {}))}>sessions:list</Btn>
        <Btn
          tone="primary"
          onClick={() =>
            void r.run("sessions:create", async () =>
              eth().call(
                "sessions:create",
                await signed({
                  chainId: network?.chainId ?? 1337,
                  origin: origin.trim(),
                  targets: list(targets).map(hex),
                  perTxEth,
                  dailyEth,
                  hours: Number(hours),
                  tokens: JSON.parse(tokens || "[]"),
                }),
              ),
            )
          }
        >
          Create session
        </Btn>
        <Field label="Session id" value={revokeId} onChange={setRevokeId} />
        <Btn
          tone="danger"
          onClick={() =>
            void r.run("sessions:revoke", async () =>
              eth().call("sessions:revoke", await signed({ id: hex(revokeId) })),
            )
          }
        >
          Revoke
        </Btn>
      </Row>
    </Panel>
  );
}

// ---- Dapp simulator ------------------------------------------------------------------------------------------------

function DappPanel({ approvals, onResolved }: { approvals: string[]; onResolved: (id: string) => void }) {
  const r = useRunner();
  const [origin, setOrigin] = useState("https://app.example");
  const [to, setTo] = useState("");
  const [value, setValue] = useState("0.001");
  const [data, setData] = useState("0x");
  const [calls, setCalls] = useState('[{"to":"0x…","value":"0x0","data":"0x"}]');
  const [callsId, setCallsId] = useState("");
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const p = (method: string, params?: unknown) => r.run(method, () => eth().provider(origin.trim(), method, params));
  const from = async () => ((await eth().provider(origin.trim(), "eth_accounts")) as string[])[0];
  return (
    <Panel
      id="dapp"
      title="Dapp simulator"
      runner={r}
      hint="EIP-1193 requests as a site would send them. A request a session covers is signed with no prompt; anything else waits for an approval below (the extension's approval window)."
    >
      <Row>
        <Field label="Site origin" value={origin} onChange={setOrigin} />
        <Btn tone="primary" onClick={() => void p("eth_requestAccounts")}>
          eth_requestAccounts
        </Btn>
        <Btn onClick={() => void p("eth_accounts")}>eth_accounts</Btn>
        <Btn onClick={() => void p("eth_chainId")}>eth_chainId</Btn>
        <Btn
          onClick={() =>
            void r.run("wallet_getCapabilities", async () =>
              eth().provider(origin.trim(), "wallet_getCapabilities", [await from()]),
            )
          }
        >
          wallet_getCapabilities
        </Btn>
      </Row>
      <Row>
        <Field label="to" value={to} onChange={setTo} />
        <Field label="value (ETH)" value={value} onChange={setValue} />
        <Field label="data" value={data} onChange={setData} />
        <Btn
          tone="primary"
          onClick={() =>
            void r.run("eth_sendTransaction", async () =>
              eth().provider(origin.trim(), "eth_sendTransaction", [
                { from: await from(), to: to.trim(), value: toHex(parseEther(value.trim() || "0")), data: data.trim() },
              ]),
            )
          }
        >
          eth_sendTransaction
        </Btn>
      </Row>
      <Field label="wallet_sendCalls calls JSON" value={calls} onChange={setCalls} area wide />
      <Row>
        <Btn
          onClick={() =>
            void r.run("wallet_sendCalls", async () =>
              eth().provider(origin.trim(), "wallet_sendCalls", [
                {
                  version: "2.0.0",
                  chainId: toHex(eth().network?.chainId ?? 1337),
                  from: await from(),
                  atomicRequired: true,
                  calls: JSON.parse(calls),
                },
              ]),
            )
          }
        >
          wallet_sendCalls
        </Btn>
        <Field label="Calls id" value={callsId} onChange={setCallsId} />
        <Btn onClick={() => void p("wallet_getCallsStatus", [callsId.trim()])}>wallet_getCallsStatus</Btn>
      </Row>
      <Row>
        <Btn onClick={() => void r.run("permissions:list", () => eth().call("permissions:list"))}>Connected sites</Btn>
        <Btn
          tone="danger"
          onClick={() =>
            void r.run("permissions:revoke", () => eth().call("permissions:revoke", { origin: origin.trim() }))
          }
        >
          Disconnect site
        </Btn>
      </Row>
      <div className="rounded-md border border-dashed border-line p-3">
        <p className="mb-2 text-[13px] font-semibold">Pending approvals ({approvals.length})</p>
        <Check label="Always allow (connect)" checked={alwaysAllow} onChange={setAlwaysAllow} />
        {approvals.map((id) => (
          <Row key={id}>
            <code className="text-[12px]">{id}</code>
            <Btn onClick={() => void r.run("approval:get", () => eth().call("approval:get", { id }))}>View</Btn>
            <Btn onClick={() => void r.run("approval:preview", () => eth().call("approval:preview", { id }))}>
              Preview tx
            </Btn>
            <Btn
              tone="primary"
              onClick={() =>
                void r
                  .run("approval:resolve ✓", async () =>
                    eth().call("approval:resolve", await signed({ id, approved: true, alwaysAllow })),
                  )
                  .then(() => onResolved(id))
              }
            >
              Approve
            </Btn>
            <Btn
              tone="danger"
              onClick={() =>
                void r
                  .run("approval:resolve ✗", () => eth().call("approval:resolve", { id, approved: false }))
                  .then(() => onResolved(id))
              }
            >
              Reject
            </Btn>
          </Row>
        ))}
      </div>
    </Panel>
  );
}

// ---- Keys & recovery -----------------------------------------------------------------------------------------------

function KeysPanel() {
  const r = useRunner();
  const [ids, setIds] = useState("");
  const [recoveryId, setRecoveryId] = useState("");
  return (
    <Panel
      id="keys"
      title="Keys & recovery"
      runner={r}
      hint="The keystore's keys (kinds, roles, expiry), guardians, guardian recoveries in progress, owner signatures left."
    >
      <Row>
        <Btn tone="primary" onClick={() => void r.run("keys:view", () => eth().call("keys:view", {}))}>
          keys:view
        </Btn>
        <Field label="Expired key ids" value={ids} onChange={setIds} />
        <Btn
          onClick={() =>
            void r.run("keys:prune", async () => eth().call("keys:prune", await signed({ ids: list(ids).map(hex) })))
          }
        >
          Prune
        </Btn>
        <Field label="Recovery id" value={recoveryId} onChange={setRecoveryId} />
        <Btn
          tone="danger"
          onClick={() =>
            void r.run("keys:cancelRecovery", async () =>
              eth().call("keys:cancelRecovery", await signed({ id: hex(recoveryId) })),
            )
          }
        >
          Cancel recovery
        </Btn>
      </Row>
    </Panel>
  );
}

// ---- Move to quantum-safe ------------------------------------------------------------------------------------------

function MigratePanel() {
  const r = useRunner();
  const [kind, setKind] = useState<"eoa" | "safe" | "smart-account">("eoa");
  const [address, setAddress] = useState("");
  const [keys, setKeys] = useState("");
  const [keepAddress, setKeep] = useState(false);
  const req = () => ({
    kind,
    keys: list(keys).map(hex),
    ...(address.trim() ? { address: hex(address) } : {}),
    ...(kind === "eoa" ? { keepAddress } : {}),
  });
  return (
    <Panel
      id="migrate"
      title="Move to quantum-safe"
      runner={r}
      hint="EOA → new account (or keep the address with EIP-7702); a UUPS account upgrades in place; a Safe moves everything in one Safe tx. Devnet test keys only: imported keys are used once and never stored."
    >
      <Row>
        <Select
          label="From"
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={["eoa", "safe", "smart-account"]}
        />
        <Field label="Address (EOA: optional)" value={address} onChange={setAddress} />
        {kind === "eoa" && <Check label="Keep the address (EIP-7702)" checked={keepAddress} onChange={setKeep} />}
      </Row>
      <Field label="Private keys (EOA key / Safe owners / account owner)" value={keys} onChange={setKeys} area wide />
      <Row>
        <Btn onClick={() => void r.run("migrate:preview", () => eth().call("migrate:preview", req()))}>Preview</Btn>
        <Btn
          tone="primary"
          onClick={() => void r.run("migrate:run", async () => eth().call("migrate:run", await signed(req())))}
        >
          Run the move
        </Btn>
      </Row>
    </Panel>
  );
}

// ---- Private balance -----------------------------------------------------------------------------------------------

function PrivacyPanel() {
  const r = useRunner();
  const [cfg, setCfg] = useState({ entrypoint: "", pool: "", poolPayer: "", deployBlock: "0", sidecarUrl: "" });
  const [kind, setKind] = useState("shield");
  const [amount, setAmount] = useState("0.01");
  const [note, setNote] = useState("");
  const [opId, setOpId] = useState("");
  const set = (k: keyof typeof cfg) => (v: string) => setCfg((c) => ({ ...c, [k]: v }));
  return (
    <Panel
      id="privacy"
      title="Private balance"
      runner={r}
      hint="Privacy Pools. Move to private works; Move to public and the public exit need the Groth16 prover, which the web engine doesn't host yet (the extension runs it in its offscreen document)."
    >
      <Row>
        <Btn onClick={() => void r.run("privacy:view", () => eth().call("privacy:view", {}))}>privacy:view</Btn>
        <Btn onClick={() => void r.run("privacy:sync", () => eth().call("privacy:sync", {}))}>Sync notes</Btn>
        <Btn onClick={() => void r.run("privacy:connection", () => eth().call("privacy:connection", {}))}>
          Connection
        </Btn>
        <Btn onClick={() => void r.run("privacy:dismiss", () => eth().call("privacy:dismiss", {}))}>Dismiss</Btn>
      </Row>
      <Row>
        <Field label="Entrypoint" value={cfg.entrypoint} onChange={set("entrypoint")} />
        <Field label="Pool" value={cfg.pool} onChange={set("pool")} />
        <Field label="PoolPayer" value={cfg.poolPayer} onChange={set("poolPayer")} />
        <Field label="Deploy block" value={cfg.deployBlock} onChange={set("deployBlock")} />
        <Field label="Staked sidecar (opt.)" value={cfg.sidecarUrl} onChange={set("sidecarUrl")} />
        <Btn
          onClick={() =>
            void r.run("privacy:saveConfig", () =>
              eth().call("privacy:saveConfig", {
                entrypoint: cfg.entrypoint,
                pool: cfg.pool,
                poolPayer: cfg.poolPayer,
                deployBlock: cfg.deployBlock,
                ...(cfg.sidecarUrl ? { sidecarUrl: cfg.sidecarUrl } : {}),
              }),
            )
          }
        >
          Save pool config
        </Btn>
      </Row>
      <Row>
        <Select label="Operation" value={kind} onChange={setKind} options={["shield", "unshield", "exit"]} />
        <Field label="Amount (ETH)" value={amount} onChange={setAmount} />
        <Field label='Note (exit) {"depositIndex":0,"secretIndex":0}' value={note} onChange={setNote} />
        <Btn
          tone="primary"
          onClick={() =>
            void r.run("privacy:start", async () =>
              eth().call(
                "privacy:start",
                await signed({
                  kind: kind as never,
                  amountWei: parseEther(amount.trim() || "0").toString(),
                  ...(note.trim() ? { note: JSON.parse(note) } : {}),
                }),
              ),
            )
          }
        >
          Start
        </Btn>
        <Field label="Operation id" value={opId} onChange={setOpId} />
        <Btn
          onClick={() => void r.run("privacy:retry", async () => eth().call("privacy:retry", await signed({ opId })))}
        >
          Retry
        </Btn>
        <Btn tone="danger" onClick={() => void r.run("privacy:cancel", () => eth().call("privacy:cancel", { opId }))}>
          Cancel
        </Btn>
      </Row>
    </Panel>
  );
}

// ---- LeanPool node ------------------------------------------------------------------------------------------------

function LeanPoolPanel({ network }: { network?: NetworkInfo }) {
  const r = useRunner();
  const [poolId, setPoolId] = useState("");
  const rpc = (method: string, params: unknown[]) =>
    r.run(method, async () => {
      const url = (await eth().getNetwork()).leanpoolUrl;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return res.json();
    });
  return (
    <Panel
      id="leanpool"
      title="LeanPool node"
      runner={r}
      hint={`Owner payments go to ${network?.leanpoolUrl ?? "the LeanPool node"}. Stages: pooled → posted → submitted → mined (or reverted / refused).`}
    >
      <Row>
        <Btn onClick={() => void rpc("leanpool_status", [])}>leanpool_status</Btn>
        <Field label="Pool id (Activity's hash)" value={poolId} onChange={setPoolId} />
        <Btn onClick={() => void rpc("leanpool_getTx", [poolId.trim()])}>leanpool_getTx</Btn>
      </Row>
    </Panel>
  );
}

// ---- Raw -----------------------------------------------------------------------------------------------------------

function RawPanel() {
  const r = useRunner();
  const [type, setType] = useState<UiType>("state:get");
  const [payload, setPayload] = useState("");
  return (
    <Panel
      id="raw"
      title="Raw UiApi call"
      runner={r}
      hint="Any message of apps/extension/src/shared/messages.ts › UiApi."
    >
      <Row>
        <Select label="Type" value={type} onChange={(v) => setType(v as UiType)} options={UI_TYPES} />
      </Row>
      <Field label="Payload JSON (empty: none)" value={payload} onChange={setPayload} area wide />
      <Row>
        <Btn
          tone="primary"
          onClick={() => void r.run(type, () => eth().call(type, payload.trim() ? JSON.parse(payload) : undefined))}
        >
          Call
        </Btn>
      </Row>
    </Panel>
  );
}

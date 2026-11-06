import {
  FrameCodecError,
  decodeTx,
  profiles,
  roleSignerVerifyData,
  sigHash as frameSigHash,
  type FrameTx,
  type Profile,
} from "@leaked/frames";
import { schemeById } from "@leaked/pq-signer";
import { decodeSignRequest, ROLE, TX_TYPE, type AdvisoryPolicy, type SignRequest } from "@leaked/ur";
import {
  decodeAbiParameters,
  decodeFunctionData,
  hashTypedData,
  isAddressEqual,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import {
  checksum,
  formatBps,
  formatDate,
  formatDuration,
  formatDurationAdjective,
  formatEth,
  formatGwei,
  formatUnits,
  formatUsd6,
  shortAddress,
  shortHex,
  usdValue,
} from "./format.js";
import {
  NATIVE,
  abiOf,
  chainName,
  enumLabel,
  lookup,
  privacyEntrypoint,
  tokenInfo,
  typedDataSpec,
  type ChangeSpec,
  type FieldFormat,
  type FormatSpec,
  type FunctionEntry,
  type SettingKey,
} from "./registry.js";
import type { AccountSnapshot, AddressBookEntry, DeviceContext } from "./types.js";

/**
 * Clear signing (plan §20 §4.3, ux-spec §4.4). Turns a `ur:leaked-sign-request` into what the review screen shows,
 * using only on-device knowledge: the bundled registry, this phone's address book and its own snapshot of what it
 * signed. The request's advisory keys (11 intent, 12 policy) are never shown as truth: key 11 only feeds the
 * mismatch check, key 12 only fills in "current value" / USD estimates that are labelled as browser-reported.
 *
 * The digest is recomputed here from the decoded transaction (never taken from the request), so what is displayed is
 * what is signed by construction. The signing worker runs this same function on the same bytes before it signs.
 */

export const DEFAULT_TIMELOCK_SECONDS = 172_800n;
/** `onlyRecovery` entry points: a Vault can't sign them. */
const RECOVERY_ONLY_IDS = new Set([
  "account.recoveryStartVaultRotation",
  "account.recoveryCancel",
  "account.recoveryCancelVaultRotation",
]);
/** What recovery mode signs (plan §20 §5): the recovery-only calls plus the permissionless finalisation. */
const RECOVERY_MODE_IDS = new Set([...RECOVERY_ONLY_IDS, "account.recoveryFinalizeVaultRotation"]);
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export type RejectCode = "E-70" | "E-71" | "E-72" | "E-75" | "E-76" | "E-77" | "E-78" | "E-79";

/** The request cannot be signed at all. Copy follows ux-spec §7 (E-70…E-72) and extends it. */
export class RequestRejected extends Error {
  constructor(
    readonly code: RejectCode,
    readonly title: string,
    readonly body: string,
  ) {
    super(`${code}: ${title}`);
    this.name = "RequestRejected";
  }
}

const reject = (code: RejectCode, title: string, body: string): never => {
  throw new RequestRejected(code, title, body);
};

export interface RecipientView {
  address: Address;
  name?: string;
  known: boolean;
}

export interface AmountView {
  text: string;
  usd?: { text: string; source: "phone" | "browser" };
  /** Token metadata is not in this app: the amount is in raw units. */
  unknownToken?: boolean;
}

export interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface TimingView {
  /** Seconds until it takes effect; 0 = now; undefined = depends (see text). */
  waitSeconds?: bigint;
  text: string;
}

export interface ActionView {
  /** Registry id (`erc20.transfer`) or a built-in (`native.send`, `unknown.call`). */
  id: string;
  /** Short action name used for the mismatch comparison (`send`, `vaultSetCap`, …). */
  action: string;
  /** One plain-language sentence, e.g. "Send 250 USDC to Alice (0x1234…abcd)". */
  title: string;
  admin: boolean;
  consequence?: string;
  timing: TimingView;
  amount?: AmountView;
  recipient?: RecipientView;
  details: DetailRow[];
  /** "Current values as reported by your browser": the from-values were not signed by this phone. */
  currentFromBrowser?: boolean;
  /** Raises risk (has to go through the waiting period). */
  loosening?: boolean;
  unknown?: { reason: string; target: Address; data: Hex; value: bigint };
  compare?: { recipient?: Address; amount?: bigint; token?: Address };
}

export interface Warning {
  code: "mismatch" | "E-74" | "direct-loosening" | "new-account" | "unknown-pool" | "browser-values";
  title: string;
  body: string;
}

export interface StructureView {
  chainId: bigint;
  chainName: string;
  /** The role signer (tx.sender). */
  sender?: Address;
  account?: Address;
  path?: "A" | "B";
  steps?: number;
  sequence?: bigint;
  maxFee?: string;
  profileId?: string;
  origin?: string;
  requestId: string;
  /** The digest this phone signs, recomputed from the decoded request. */
  fingerprint: Hex;
}

export interface Review {
  kind: "frameTx" | "typedData";
  request: SignRequest;
  /** What gets signed: the frame tx's sig hash, or the EIP-712 digest. */
  digest: Hex;
  /** The PQ witness goes to this entry (frame tx). */
  sigIndex?: number;
  /** Path B: the payer key must sign the same digest. */
  needsPayerSig: boolean;
  headline: string;
  admin?: { sentence: string; consequence?: string };
  actions: ActionView[];
  warnings: Warning[];
  mismatch: string[];
  unknown: boolean;
  /** How the approve control behaves: plain, demoted ("Approve anyway"), or long-press + typed confirmation. */
  approval: "normal" | "anyway" | "unknown";
  structure: StructureView;
  recoveryMode: boolean;
  /** The request is for this phone's prepared replacement key, not its current one (key rotation). */
  signingKey?: "next";
}

// ---------------------------------------------------------------------------------------------------------------

export function reviewRequestBytes(cbor: Uint8Array, ctx: DeviceContext): Review {
  return reviewRequest(decodeSignRequest(cbor), ctx);
}

export function reviewRequest(req: SignRequest, ctx: DeviceContext): Review {
  if (req.role === ROLE.guardian) {
    reject(
      "E-75",
      "This request is for a Guardian",
      "A Guardian approves with its own key. This phone holds a Vault key.",
    );
  }
  if (ctx.mode === "vault" && req.role === ROLE.recovery) {
    reject(
      "E-75",
      "This is a Recovery key request",
      "To sign it, open Recovery › Use Recovery key and enter the Recovery words.",
    );
  }
  if (ctx.mode === "recovery" && req.role !== ROLE.recovery) {
    reject(
      "E-75",
      "Recovery mode signs Recovery requests only",
      "Leave Recovery mode to approve this with your Vault.",
    );
  }
  if (req.txType === TX_TYPE.typedData) return reviewTypedData(req, ctx);
  if (req.txType !== TX_TYPE.frameTx) {
    reject(
      "E-76",
      "This kind of request isn't supported yet",
      "This app signs native LEAKED accounts only. Update the app.",
    );
  }
  return reviewFrameTx(req, ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Frame transactions
// ---------------------------------------------------------------------------------------------------------------

function reviewFrameTx(req: SignRequest, ctx: DeviceContext): Review {
  if (req.schemeId?.toLowerCase() !== ctx.schemeId.toLowerCase()) {
    reject("E-70", "This request is for a key this phone doesn't hold.", "It asks for a different kind of signature.");
  }
  const expected = req.expectedPk?.toLowerCase();
  const signingKey: "current" | "next" | undefined =
    expected === ctx.publicKey.toLowerCase()
      ? "current"
      : ctx.nextPublicKey && expected === ctx.nextPublicKey.toLowerCase()
        ? "next"
        : undefined;
  if (!signingKey) {
    reject(
      "E-71",
      "This request is for a different Vault.",
      ctx.mode === "recovery"
        ? "The words you entered make a different Recovery key than the one this account uses."
        : "Check that this phone is the Vault paired with this account (Security › Vault in the browser).",
    );
  }
  const profile: Profile | undefined = req.profileId ? profiles[req.profileId] : undefined;
  if (!profile) {
    reject("E-72", "This request uses a network format this app doesn't know.", "Update the app.");
  }
  const p = profile!;
  if (p.devnet.chainId !== undefined && p.devnet.chainId !== Number(req.chainId)) {
    reject("E-72", "This request uses the wrong network format for its network.", "Start again in the browser.");
  }

  let tx: FrameTx;
  let digest: Hex;
  try {
    ({ tx, digest } = frameDigest(p, req.payload));
  } catch (e) {
    const why = e instanceof FrameCodecError ? e.message : String(e);
    return reject("E-77", "This request can't be read.", `It is not a valid transaction for this network (${why}).`);
  }
  if (tx.chainId !== req.chainId)
    reject("E-77", "This request is inconsistent.", "Its network doesn't match its contents.");

  // --- signature entries: these decide whether a valid signature can exist at all -------------------------------
  const sigIndex = req.sigIndex!;
  const ARB = p.sigSchemes.ARBITRARY;
  const SECP = p.sigSchemes.SECP256K1;
  const entry = tx.signatures[sigIndex];
  if (!entry || entry.scheme !== ARB || entry.msg !== "0x" || entry.signer !== "0x") {
    reject("E-77", "This request can't be signed.", "It has no place for this phone's quantum-safe signature.");
  }
  const placeholderLen = (entry!.signature.length - 2) / 2;
  const zeros = /^0x(00)*$/.test(entry!.signature);
  const sigLength = schemeById(ctx.schemeId)?.SIG_LENGTH ?? 3688;
  const okLen = placeholderLen === sigLength || (p.sigHashElision === "empty" && placeholderLen === 0);
  if (!zeros || !okLen)
    reject("E-77", "This request can't be signed.", "Its signature slot is not empty or has the wrong size.");

  let path: "A" | "B";
  if (tx.signatures.length === 1) path = "A";
  else if (tx.signatures.length === 2) {
    path = "B";
    const payerIdx = sigIndex === 0 ? 1 : 0;
    const pe = tx.signatures[payerIdx]!;
    if (pe.scheme !== SECP || pe.msg !== "0x")
      reject("E-77", "This request can't be signed.", "Its fee-payment slot is malformed.");
    // Path B: the role's own secp256k1 fee key signs entry 1 (the Vault's, or since the Recovery bootstrap the
    // Recovery key's, both derived on this phone from the words).
    if (!ctx.payerAddress || pe.signer.length !== 42 || !isAddressEqual(pe.signer as Address, ctx.payerAddress)) {
      reject(
        "E-78",
        "This request expects a different fee-payment key.",
        ctx.mode === "recovery"
          ? "The Recovery words you entered make a different fee-payment key than the one this account uses."
          : "Check that this phone is the Vault paired with this account.",
      );
    }
  } else {
    return reject("E-77", "This request can't be signed.", `It has ${tx.signatures.length} signature slots.`);
  }

  const sender = checksum(tx.sender);
  const warnings: Warning[] = [];
  const actions: ActionView[] = [];
  let account: Address | undefined;

  // --- structure: [VERIFY(signer, verifyFrame(i)), SENDER(signer, executePQ(i, target, data) | relay(target, data))] -
  const structural: string[] = [];
  const isSelf = (t: Address | null) => t === null || isAddressEqual(t, sender);
  const f0 = tx.frames[0];
  const f1 = tx.frames[1];
  if (tx.frames.length !== 2) structural.push(`it has ${tx.frames.length} steps instead of 2`);
  // Every step beyond the two expected ones is a call from the signer the user must see, not just count.
  for (const f of tx.frames.slice(2)) {
    actions.push(unknownAction(ctx, req.chainId, (f.target ?? sender) as Address, f.data, f.value, "Extra step"));
  }
  if (!f0 || f0.mode !== p.frameModes.VERIFY || !isSelf(f0.target) || f0.value !== 0n) {
    structural.push("its first step is not the Vault's own check");
  } else if (
    (f0.flags & 0x3) !== p.approveScopes.EXECUTION_AND_PAYMENT ||
    f0.data.toLowerCase() !== roleSignerVerifyData(BigInt(sigIndex))
  ) {
    structural.push("its first step checks a different signature slot");
  }
  if (tx.blobVersionedHashes.length > 0 || tx.recentRootReferences.length > 0) structural.push("it carries extra data");

  if (!f1 || f1.mode !== p.frameModes.SENDER || !isSelf(f1.target) || f1.value !== 0n) {
    structural.push("its second step does not go through the Vault signer");
    if (f1)
      actions.push(
        unknownAction(ctx, req.chainId, (f1.target ?? sender) as Address, f1.data, f1.value, "Unrecognised step"),
      );
  } else {
    const outer = lookup("roleSigner", f1.data);
    const wantOuter = path === "B" ? "executePQ" : "relay";
    if (!outer || outer.item.name !== wantOuter) {
      structural.push(`its second step is not a Vault-signed call (${outer?.item.name ?? "unknown"})`);
      actions.push(unknownAction(ctx, req.chainId, sender, f1.data, 0n, "Unrecognised step"));
    } else {
      const args = decodeArgs(outer, f1.data);
      if (path === "B" && args.sigIndex !== BigInt(sigIndex)) structural.push("it checks a different signature slot");
      const target = checksum(args.target as string);
      const data = args.data as Hex;
      if (isAddressEqual(target, sender)) {
        actions.push(...renderEntryCall("roleSigner", sender, 0n, data, rc(ctx, req, undefined)));
      } else {
        account = target;
        const r = rc(ctx, req, account);
        if (!r.snapshot && ctx.snapshots.length > 0) {
          warnings.push({
            code: "new-account",
            title: "First approval for this account on this phone",
            body: `Account ${shortAddress(account)}. If you don't recognise it, reject.`,
          });
        }
        actions.push(...renderEntryCall("account", account, 0n, data, r));
      }
    }
  }
  if (structural.length > 0) {
    actions.unshift({
      id: "unknown.structure",
      action: "unknown",
      title: "Unusual approval structure",
      admin: false,
      timing: { text: "unknown" },
      details: structural.map((s) => ({ label: "Why", value: s })),
      unknown: {
        reason: `This approval is not shaped like a LEAKED Vault approval: ${structural.join("; ")}.`,
        target: sender,
        data: req.payload,
        value: 0n,
      },
    });
  }

  // --- recovery guard (plan §20 §5: recovery mode refuses any other selector) -------------------------------------
  if (ctx.mode === "recovery") {
    if (actions.length !== 1 || !RECOVERY_MODE_IDS.has(actions[0]!.id)) {
      reject(
        "E-79",
        "Recovery mode only replaces the Vault or cancels a change.",
        "This request asks for something else. Nothing was signed.",
      );
    }
  } else if (actions.some((a) => RECOVERY_ONLY_IDS.has(a.id))) {
    reject(
      "E-79",
      "This needs your Recovery key, not the Vault.",
      "Use Recovery › Use Recovery key on a phone with your Recovery words.",
    );
  }

  const structure: StructureView = {
    chainId: req.chainId,
    chainName: chainName(req.chainId),
    sender,
    path,
    steps: tx.frames.length,
    sequence: tx.nonceSeq,
    maxFee: maxFeeText(p, tx),
    profileId: p.id,
    requestId: req.requestId,
    fingerprint: digest,
    ...(account ? { account } : {}),
    ...(req.origin ? { origin: req.origin } : {}),
  };

  const review = finish(req, ctx, "frameTx", digest, actions, warnings, structure, {
    sigIndex,
    needsPayerSig: path === "B",
    account,
  });
  return signingKey === "next" ? { ...review, signingKey } : review;
}

/**
 * The digest a role signer signs: `compute_sig_hash` of the transaction decoded from the request's own payload bytes
 * (canonical encoding enforced by `decodeTx`), per the request's codec profile. Exported for the vector tests.
 */
export function frameDigest(p: Profile, payload: Hex): { tx: FrameTx; digest: Hex } {
  const tx = decodeTx(p, payload);
  return { tx, digest: frameSigHash(p, tx) };
}

function maxFeeText(p: Profile, tx: FrameTx): string {
  if (tx.fees.maxFee !== undefined) return formatEth(tx.fees.maxFee);
  // Per-gas fee profiles: the worst case is every frame's limit plus the intrinsic cost (EIP-8141: 12,000 + 475 per
  // frame) plus the calldata floor of the whole payload (64 gas per byte), all at maxFeePerGas.
  const limits = tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n);
  const payloadBytes = BigInt(
    tx.frames.reduce((s, f) => s + (f.data.length - 2) / 2, 0) +
      tx.signatures.reduce((s, e) => s + (e.signature.length - 2) / 2, 0),
  );
  const gas = limits + 12_000n + 475n * BigInt(tx.frames.length) + 64n * payloadBytes;
  void p;
  return formatEth(gas * tx.fees.maxFeePerGas);
}

// ---------------------------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------------------------

interface RenderCtx {
  ctx: DeviceContext;
  chainId: bigint;
  policy?: AdvisoryPolicy;
  snapshot?: AccountSnapshot;
  account?: Address;
  /** Inside `vaultQueue`: everything waits. */
  queued?: boolean;
  depth: number;
}

function rc(ctx: DeviceContext, req: SignRequest, account: Address | undefined): RenderCtx {
  const snapshot = account
    ? ctx.snapshots.find((s) => s.chainId === Number(req.chainId) && isAddressEqual(s.account, account))
    : undefined;
  const policy =
    req.policy && (!req.policy.account || !account || isAddressEqual(req.policy.account as Address, account))
      ? req.policy
      : undefined;
  return {
    ctx,
    chainId: req.chainId,
    depth: 0,
    ...(policy ? { policy } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(account ? { account } : {}),
  };
}

function decodeArgs(entry: FunctionEntry, data: Hex): Record<string, unknown> {
  const { args } = decodeFunctionData({ abi: [entry.item], data });
  const out: Record<string, unknown> = {};
  entry.item.inputs.forEach((inp, i) => {
    out[inp.name ?? `arg${i}`] = (args as readonly unknown[] | undefined)?.[i];
  });
  return out;
}

/** A call made by a role signer: on itself (self-admin) or on the account (`vault*`/`recovery*`). */
function renderEntryCall(
  abiName: "roleSigner" | "account",
  target: Address,
  value: bigint,
  data: Hex,
  r: RenderCtx,
): ActionView[] {
  const entry = lookup(abiName, data);
  if (
    !entry ||
    !entry.format ||
    entry.item.name === "executePQ" ||
    entry.item.name === "relay" ||
    entry.item.name === "verifyFrame"
  ) {
    return [unknownAction(r.ctx, r.chainId, target, data, value, "Unrecognised call")];
  }
  let args: Record<string, unknown>;
  try {
    args = decodeArgs(entry, data);
  } catch {
    return [unknownAction(r.ctx, r.chainId, target, data, value, "Call data doesn't match its type")];
  }
  if (entry.format.kind === "container") return renderContainer(entry, args, target, r);
  return [renderFormatted(entry, args, target, r)];
}

function renderContainer(
  entry: FunctionEntry,
  args: Record<string, unknown>,
  account: Address,
  r: RenderCtx,
): ActionView[] {
  if (r.depth > 0) return [unknownAction(r.ctx, r.chainId, account, "0x", 0n, "Nested batch")];
  const calls = (args[entry.format!.callsField ?? "calls"] as { target: Address; value: bigint; data: Hex }[]) ?? [];
  const inner: RenderCtx = { ...r, depth: r.depth + 1, queued: entry.format!.timing === "waitingPeriod" };
  const out: ActionView[] = [];
  if (calls.length === 0) {
    out.push(unknownAction(r.ctx, r.chainId, account, "0x", 0n, "An empty batch"));
  }
  for (const c of calls) {
    const target = checksum(c.target);
    if (isAddressEqual(target, account)) out.push(...renderEntryCall("account", target, c.value, c.data, inner));
    else out.push(renderExternalCall(target, c.value, c.data, inner));
  }
  const extra: DetailRow[] = [];
  // `usdValue` is not shown: the account measures the real outflow and does not trust it (ILeakedAccount header),
  // and a browser-chosen number next to the decoded amount would only confuse.
  if (typeof args.kind === "number" || typeof args.kind === "bigint") {
    extra.push({ label: "Scheduled as", value: enumLabel("queueKind", String(args.kind)) ?? `kind ${args.kind}` });
  }
  if (typeof args.opId === "string")
    extra.push({ label: "Scheduled change", value: shortHex(args.opId as Hex), mono: true });
  if (out[0]) out[0].details.push(...extra);
  return out;
}

/** A call from the account to anything else: a token, ETH, a known app, or unknown. */
function renderExternalCall(target: Address, value: bigint, data: Hex, r: RenderCtx): ActionView {
  const timing = timingFor("now", r, false);
  if (data === "0x") {
    const recipient = recipientView(r.ctx, r.chainId, target);
    const amount = amountView(r, ZERO, value);
    return {
      id: "native.send",
      action: "send",
      title: `Send ${amount.text} to ${addressPhrase(recipient)}`,
      admin: false,
      timing,
      amount,
      recipient,
      details: [],
      compare: { recipient: target, amount: value, token: ZERO },
    };
  }
  const erc20 = lookup("erc20", data);
  const pp = privacyEntrypoint(r.chainId);
  const ppEntry = pp && isAddressEqual(pp, target) ? lookup("privacyPoolsEntrypoint", data) : undefined;
  const entry = ppEntry ?? erc20;
  if (!entry) return unknownAction(r.ctx, r.chainId, target, data, value, "Unrecognised call");
  let args: Record<string, unknown>;
  try {
    args = decodeArgs(entry, data);
  } catch {
    return unknownAction(r.ctx, r.chainId, target, data, value, "Call data doesn't match its type");
  }
  const view = renderFormatted(entry, args, target, r);
  if (value > 0n) {
    view.title += ` and send ${formatEth(value)}`;
    view.details.push({ label: "Also sends", value: formatEth(value) });
  }
  return view;
}

function unknownAction(
  ctx: DeviceContext,
  chainId: bigint,
  target: Address,
  data: Hex,
  value: bigint,
  reason: string,
): ActionView {
  const recipient = recipientView(ctx, chainId, target);
  return {
    id: "unknown.call",
    action: "unknown",
    title: `Unrecognised call to ${addressPhrase(recipient)}`,
    admin: false,
    timing: { text: "unknown" },
    recipient,
    details: [
      { label: "Contract", value: checksum(target), mono: true },
      ...(value > 0n ? [{ label: "Sends", value: formatEth(value) }] : []),
      { label: "Function", value: data.length >= 10 ? data.slice(0, 10) : "(none)", mono: true },
    ],
    unknown: { reason, target, data, value },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Descriptor-driven rendering
// ---------------------------------------------------------------------------------------------------------------

function renderFormatted(
  entry: FunctionEntry,
  args: Record<string, unknown>,
  target: Address,
  r: RenderCtx,
): ActionView {
  const f = entry.format!;
  const details: DetailRow[] = [];
  let recipient: RecipientView | undefined;
  let amount: AmountView | undefined;
  let loosening = false;
  let currentFromBrowser = false;

  // Field values, rendered.
  const values: Record<string, string> = {};
  for (const [name, spec] of Object.entries(f.fields ?? {})) {
    const raw = spec.path ? resolvePath(args, spec.path) : args[name];
    const rendered = renderField(spec, raw, target, r, args);
    values[name] = rendered.text;
    if (rendered.recipient && "recipient" in spec && spec.recipient) recipient = rendered.recipient;
    if (rendered.amount) amount = rendered.amount;
    details.push({
      label: labelFor(name),
      value: rendered.detail ?? rendered.text,
      ...(rendered.mono ? { mono: true } : {}),
    });
  }
  for (const [name, d] of Object.entries(f.derived ?? {})) {
    const on = args[d.when.field] === d.when.equals;
    values[name] = on ? interpolate(d.template, values) : "";
  }

  let title = f.intent ? interpolate(f.intent, values) : entry.item.name;

  // "from → to" changes (limits, waiting period).
  if (f.changes) {
    const sentences: string[] = [];
    for (const c of f.changes) {
      const next = toBig(args[c.field]);
      const cur = currentSetting(c.current, r);
      if (cur?.source === "browser") currentFromBrowser = true;
      const fmt = (v: bigint) => formatChange(c, v);
      if (cur && cur.value === next) {
        details.push({ label: capital(c.label), value: `${fmt(next)} (unchanged)` });
        continue;
      }
      // Direction ("raise"/"lower", and whether it loosens) is only computed from what this phone signed itself. A
      // browser-reported current value is shown, labelled, but cannot make a raise read as a lowering, and the change
      // is treated as loosening (the conservative reading) until the phone has its own snapshot.
      const trusted = cur?.source === "phone";
      const raises = trusted ? next > cur.value : undefined;
      const looser = trusted ? (c.looser === "higher" ? next > cur.value : next < cur.value) : true;
      if (looser) loosening = true;
      const verb = raises === undefined ? "set" : raises ? "raise" : "lower";
      // The headline carries only the signed value when the "from" is untrusted; the row below shows both.
      sentences.push(
        trusted ? `${verb} ${c.label} from ${fmt(cur.value)} → ${fmt(next)}` : `${verb} ${c.label} to ${fmt(next)}`,
      );
      details.push({
        label: capital(c.label),
        value: cur ? `${fmt(cur.value)}${trusted ? "" : " (browser)"} → ${fmt(next)}` : fmt(next),
      });
    }
    title = sentences.length > 0 ? capital(sentences.join(" and ")) : "No change to your settings";
  }
  if (f.looserWhen) {
    const v = args[f.looserWhen.field];
    if (f.looserWhen.equals !== undefined && v === f.looserWhen.equals) loosening = true;
    if (f.looserWhen.greaterThan !== undefined && toBig(v) > BigInt(f.looserWhen.greaterThan)) loosening = true;
  }

  const timing = timingFor(f.timing ?? "now", r, loosening);
  const view: ActionView = {
    id: entry.id,
    action: f.action ?? entry.item.name,
    title,
    admin: !!f.admin,
    timing,
    details,
    ...(f.consequence ? { consequence: interpolate(f.consequence, values) } : {}),
    ...(recipient ? { recipient } : {}),
    ...(amount ? { amount } : {}),
    ...(loosening ? { loosening } : {}),
    ...(currentFromBrowser ? { currentFromBrowser } : {}),
  };
  if (f.compare) {
    const cmp: ActionView["compare"] = {};
    if (f.compare.recipient) {
      const v = f.fields?.[f.compare.recipient]?.path
        ? resolvePath(args, f.fields[f.compare.recipient]!.path!)
        : args[f.compare.recipient];
      if (typeof v === "string") cmp.recipient = checksum(v);
    }
    if (f.compare.amount) cmp.amount = toBig(args[f.compare.amount]);
    if (f.compare.token) cmp.token = f.compare.token === "@.target" ? target : (args[f.compare.token] as Address);
    view.compare = cmp;
  }
  return view;
}

interface Rendered {
  text: string;
  detail?: string;
  mono?: boolean;
  recipient?: RecipientView;
  amount?: AmountView;
}

function renderField(
  spec: FieldFormat,
  raw: unknown,
  target: Address,
  r: RenderCtx,
  args: Record<string, unknown>,
): Rendered {
  switch (spec.format) {
    case "addressName": {
      const rec = recipientView(r.ctx, r.chainId, checksum(String(raw)));
      return { text: addressPhrase(rec), detail: checksum(String(raw)), mono: !rec.name, recipient: rec };
    }
    case "tokenAmount": {
      const token = spec.tokenPath === "@.target" ? target : checksum(String(args[spec.tokenPath]));
      const v = toBig(raw);
      if (spec.unlimitedAbove && v >= BigInt(spec.unlimitedAbove)) {
        const sym = tokenSymbol(r, token);
        return { text: `an unlimited amount of ${sym}`, amount: { text: `Unlimited ${sym}` } };
      }
      const amount = amountView(r, token, v);
      return { text: amount.text, amount };
    }
    case "tokenName": {
      const a = checksum(String(raw));
      const t = tokenInfo(r.chainId, a);
      return { text: t ? `${t.symbol} (${shortAddress(a)})` : shortAddress(a), detail: a, mono: !t };
    }
    case "usd6":
      return { text: formatUsd6(toBig(raw)) };
    case "eth":
      return { text: formatEth(toBig(raw)) };
    case "gwei":
      return { text: formatGwei(toBig(raw)) };
    case "integer":
      return { text: toBig(raw).toString() };
    case "duration":
      return { text: formatDuration(toBig(raw)) };
    case "date":
      return { text: formatDate(toBig(raw)) };
    case "shortHex":
      return { text: shortHex(String(raw) as Hex), detail: String(raw), mono: true };
    case "selector":
      return { text: String(raw), mono: true };
    case "pinnedPrice":
      return { text: `${formatUsd6(toBig(raw))} per token` };
    case "bps":
      return { text: formatBps(toBig(raw)) };
    case "count": {
      const n = Array.isArray(raw) ? raw.length : 0;
      return { text: `${n} ${spec.noun}${n === 1 ? "" : "s"}` };
    }
    case "raw":
      return { text: `${toBig(raw).toString()}${spec.unit ? ` ${spec.unit}` : ""}` };
    case "enum": {
      const key = typeof raw === "bigint" || typeof raw === "number" ? toBig(raw).toString() : String(raw);
      return { text: (spec.enum ? enumLabel(spec.enum, key) : spec.labels?.[key]) ?? key };
    }
  }
}

const LABELS: Record<string, string> = {
  to: "To",
  amount: "Amount",
  spender: "Spender",
  newHotKey: "New everyday key",
  token: "Token",
  allowed: "Change",
  usdPerToken: "Pinned price",
  maxPriorityFeePerGas: "Priority fee limit",
  selfPay: "Who pays fees",
  tank: "Fee tank",
  verifier: "Contract",
  denied: "Change",
  newRecoverySigner: "Recovery key signer",
  newPayerKey: "Fee-payment key",
  newMaxFee: "Network-fee limit",
  trusted: "Change",
  value: "Amount",
  deadline: "Until",
  decimals: "Decimals",
  target: "App or recipient",
  selector: "Function",
  allowanceUsd: "Allowance",
  expiry: "Until",
  domainSeparator: "Site id",
  guardian: "Guardian",
  enabled: "Change",
  recoverySigner: "Recovery key signer",
  newImpl: "New code",
  newAccount: "New account",
  tokens: "Tokens",
  opId: "Scheduled change",
  newVaultSigner: "New Vault signer",
  until: "Until",
  payerKey: "Fee-payment key",
  maxFee: "Network-fee limit",
  unstakeDelaySec: "Unlock delay",
  withdrawnValue: "Amount",
  recipient: "To",
  relayFeeBPS: "Relayer fee",
  mode: "Who everyday payments may go to",
};
const labelFor = (name: string) => LABELS[name] ?? name;

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "boolean") return v ? 1n : 0n;
  return 0n;
}

function formatChange(c: ChangeSpec, v: bigint): string {
  switch (c.format) {
    case "usd6":
      return formatUsd6(v);
    case "eth":
      return formatEth(v);
    case "duration":
      return formatDuration(v);
    case "integer":
      return v.toString();
  }
}

/** `a.b[2]`, and `x#(address,uint256)[0]` = ABI-decode bytes `x` as that tuple and take element 0. */
function resolvePath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    const m = /^(\w+)(?:#\(([^)]*)\))?((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    cur = (cur as Record<string, unknown> | undefined)?.[m[1]!];
    if (m[2] !== undefined) {
      try {
        cur = decodeAbiParameters(parseAbiParameters(m[2]), cur as Hex);
      } catch {
        return undefined;
      }
    }
    for (const idx of m[3]!.matchAll(/\[(\d+)\]/g)) cur = (cur as unknown[] | undefined)?.[Number(idx[1])];
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings, timing, amounts, addresses
// ---------------------------------------------------------------------------------------------------------------

function currentSetting(key: SettingKey, r: RenderCtx): { value: bigint; source: "phone" | "browser" } | undefined {
  const s = r.snapshot?.settings[key];
  if (s !== undefined) return { value: BigInt(s), source: "phone" };
  const p = r.policy?.[key];
  if (p !== undefined) return { value: BigInt(p), source: "browser" };
  return undefined;
}

function timelockDelay(r: RenderCtx): bigint {
  return currentSetting("timelockDelay", r)?.value ?? DEFAULT_TIMELOCK_SECONDS;
}

function timingFor(t: string, r: RenderCtx, loosening: boolean): TimingView {
  const wait = (): TimingView => {
    const d = timelockDelay(r);
    return { waitSeconds: d, text: `takes effect after a ${formatDurationAdjective(d)} waiting period` };
  };
  if (r.queued) return wait();
  switch (t) {
    case "waitingPeriod":
      return wait();
    case "sevenDays":
      return { waitSeconds: 604_800n, text: "takes effect in 7 days" };
    case "firstInstallNowElseWaits":
      return { text: "takes effect now if this is your first Recovery key; replacing one has to wait" };
    case "tightenNowLoosenWaits":
      return loosening
        ? { waitSeconds: 0n, text: "takes effect now (only allowed if it doesn't raise risk)" }
        : { waitSeconds: 0n, text: "takes effect now" };
    default:
      return { waitSeconds: 0n, text: "takes effect now" };
  }
}

export function recipientView(ctx: DeviceContext, chainId: bigint, address: Address): RecipientView {
  const a = checksum(address);
  const hit: AddressBookEntry | undefined = ctx.addressBook.find(
    (e) => isAddressEqual(e.address, a) && (e.chains.length === 0 || e.chains.includes(Number(chainId))),
  );
  return hit ? { address: a, name: hit.name, known: true } : { address: a, known: false };
}

/** "Alice (0x1234…abcd)" or "0x1234…abcd". */
export function addressPhrase(r: RecipientView): string {
  return r.name ? `${r.name} (${shortAddress(r.address)})` : shortAddress(r.address);
}

function tokenSymbol(r: RenderCtx, token: Address): string {
  if (isAddressEqual(token, ZERO)) return NATIVE.symbol;
  return tokenInfo(r.chainId, token)?.symbol ?? `token ${shortAddress(token)}`;
}

function amountView(r: RenderCtx, token: Address, units: bigint): AmountView {
  const native = isAddressEqual(token, ZERO);
  const reg = native ? NATIVE : tokenInfo(r.chainId, token);
  const snap = r.snapshot?.tokens[token.toLowerCase()];
  const adv = r.policy?.tokens?.find((t) => isAddressEqual(t.token as Address, token));
  // Decimals come from the bundled registry or from what this phone signed (`vaultSetToken`), never from the
  // request: browser-reported decimals could print a million-token transfer as "0.000001".
  const decimals = reg?.decimals ?? snap?.decimals;
  let text: string;
  let unknownToken = false;
  if (decimals === undefined) {
    text = `${formatUnits(units, 0)} units of token ${shortAddress(token)}`;
    unknownToken = true;
  } else {
    text = `${formatUnits(units, decimals)} ${reg?.symbol ?? `of token ${shortAddress(token)}`}`;
    if (!reg) unknownToken = true;
  }
  const view: AmountView = { text, ...(unknownToken ? { unknownToken } : {}) };
  if (decimals !== undefined) {
    if (snap && snap.allowed)
      view.usd = { text: formatUsd6(usdValue(units, decimals, snap.usdPerToken)), source: "phone" };
    else if (adv && adv.decimals === decimals)
      view.usd = { text: formatUsd6(usdValue(units, decimals, adv.usdPerToken)), source: "browser" };
  }
  return view;
}

// ---------------------------------------------------------------------------------------------------------------
// Typed data (tx-type 2): the Privacy Pools note envelope, signed by the payer key
// ---------------------------------------------------------------------------------------------------------------

interface TypedEnvelope {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

function reviewTypedData(req: SignRequest, ctx: DeviceContext): Review {
  if (ctx.mode !== "vault" || !ctx.payerAddress)
    reject("E-75", "Only the Vault signs this.", "Leave Recovery mode first.");
  if (!req.payer || !isAddressEqual(req.payer as Address, ctx.payerAddress!)) {
    reject(
      "E-78",
      "This request expects a different fee-payment key.",
      "Check that this phone is the Vault paired with this account.",
    );
  }
  let env: TypedEnvelope;
  try {
    env = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(req.payload))) as TypedEnvelope;
  } catch {
    return reject("E-77", "This request can't be read.", "Its signing data is not valid.");
  }
  const bad = (why: string): never =>
    reject(
      "E-77",
      "This app won't sign this kind of message.",
      `Only known Privacy Pools note keys can be signed (${why}).`,
    );
  if (!env || typeof env !== "object" || Array.isArray(env)) bad("not an object");
  const keys = Object.keys(env).sort().join(",");
  if (keys !== "domain,message,primaryType,types") bad("unexpected fields");
  const spec = typedDataSpec(env.primaryType);
  if (!spec) bad(`unknown type ${String(env.primaryType)}`);
  const s = spec!;
  // Types: exactly the spec's struct, optionally with the standard EIP712Domain entry.
  const typeNames = Object.keys(env.types).filter((t) => t !== "EIP712Domain");
  if (
    typeNames.join(",") !== Object.keys(s.types).join(",") ||
    JSON.stringify(env.types[env.primaryType]) !== JSON.stringify(s.types[env.primaryType])
  ) {
    bad("unexpected types");
  }
  const salt = keccak256(stringToHex(s.domain.saltPreimage));
  const d = env.domain;
  const dKeys = Object.keys(d).sort().join(",");
  if (dKeys !== "chainId,name,salt,verifyingContract,version") bad("unexpected domain");
  if (d.name !== s.domain.name || d.version !== s.domain.version || String(d.salt).toLowerCase() !== salt)
    bad("wrong domain");
  if (BigInt(d.chainId as number | string) !== req.chainId) bad("wrong network");
  if (typeof d.verifyingContract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(d.verifyingContract)) bad("bad contract");
  const fields = s.types[env.primaryType]!;
  const msgKeys = Object.keys(env.message).sort().join(",");
  if (
    msgKeys !==
    fields
      .map((f) => f.name)
      .sort()
      .join(",")
  )
    bad("unexpected message");
  const message: Record<string, bigint> = {};
  for (const f of fields) {
    const v = env.message[f.name];
    if (!(typeof v === "number" || (typeof v === "string" && /^\d{1,20}$/.test(v)))) bad(`bad ${f.name}`);
    const n = BigInt(v as string | number);
    if (n >= 1n << 64n) bad(`${f.name} out of range`);
    message[f.name] = n;
  }
  const verifyingContract = checksum(d.verifyingContract as string);
  const digest = hashTypedData({
    domain: { name: s.domain.name, version: s.domain.version, chainId: Number(req.chainId), verifyingContract, salt },
    types: { [env.primaryType]: fields },
    primaryType: env.primaryType,
    message,
  } as never);

  const warnings: Warning[] = [];
  const known = privacyEntrypoint(req.chainId);
  if (!known || !isAddressEqual(known, verifyingContract)) {
    warnings.push({
      code: "unknown-pool",
      title: "Unfamiliar Privacy Pools contract",
      body: `These note keys are for ${shortAddress(verifyingContract)}, which is not the Privacy Pools contract this app knows for ${chainName(req.chainId)}.`,
    });
  }
  const values = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, v.toString()]));
  const action: ActionView = {
    id: `typedData.${env.primaryType}`,
    action: "privacyNoteKeys",
    title: interpolate(s.intent, values),
    admin: false,
    consequence: s.consequence,
    timing: { waitSeconds: 0n, text: "nothing is sent to the network" },
    details: [
      ...fields.map((f) => ({
        label: capital(f.name.replace(/Index$/, " number")),
        value: message[f.name]!.toString(),
      })),
      { label: "Pool contract", value: verifyingContract, mono: true },
    ],
  };
  const structure: StructureView = {
    chainId: req.chainId,
    chainName: chainName(req.chainId),
    requestId: req.requestId,
    fingerprint: digest,
    ...(req.origin ? { origin: req.origin } : {}),
  };
  return finish(req, ctx, "typedData", digest, [action], warnings, structure, { needsPayerSig: false });
}

function hexToBytes(h: Hex): Uint8Array {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Assembly: headline, admin banner, mismatch, warnings
// ---------------------------------------------------------------------------------------------------------------

function finish(
  req: SignRequest,
  ctx: DeviceContext,
  kind: Review["kind"],
  digest: Hex,
  actions: ActionView[],
  warnings: Warning[],
  structure: StructureView,
  extra: { sigIndex?: number; needsPayerSig: boolean; account?: Address },
): Review {
  const unknown = actions.some((a) => a.unknown);
  const known = actions.filter((a) => !a.unknown);
  const primary = known.find((a) => a.compare) ?? known.find((a) => a.admin) ?? known[0];

  // Headline: the primary action's sentence + its timing; "and N more" for batches.
  let headline = primary ? primary.title : "Unrecognised approval";
  if (
    primary &&
    primary.timing.text !== "takes effect now" &&
    primary.timing.text !== "unknown" &&
    kind === "frameTx"
  ) {
    headline += `: ${primary.timing.text}`;
  }
  if (actions.length > 1) headline += ` (and ${actions.length - 1} more)`;

  const adminAction = known.find((a) => a.admin);
  const admin = adminAction
    ? {
        ...(adminAction.consequence ? { consequence: adminAction.consequence } : {}),
        sentence: `${adminAction.title}${adminAction.timing.text === "unknown" ? "" : `: ${adminAction.timing.text}`}.${adminAction.consequence ? ` ${adminAction.consequence}` : ""}`,
      }
    : undefined;

  for (const a of known) {
    if (a.loosening && a.timing.waitSeconds === 0n && a.id !== "account.vaultSetRecoverySigner") {
      warnings.push({
        code: "direct-loosening",
        title: a.currentFromBrowser ? "This change may have to wait" : "This change usually has to wait",
        body: a.currentFromBrowser
          ? "This phone can't tell whether it raises risk. If it does, your account only accepts it after the waiting period, and sent like this it will be refused by the network."
          : "It raises risk, so your account only accepts it after the waiting period. Sent like this, it will be refused by the network.",
      });
    }
    if (a.currentFromBrowser) {
      warnings.push({
        code: "browser-values",
        title: "Current values come from your browser",
        body: "This phone hasn't signed these settings before, so the “from” values are what your browser reports.",
      });
    }
  }

  // ux-spec E-74: the browser-reported settings differ from what this phone last signed.
  const snap = extra.account
    ? ctx.snapshots.find((s) => s.chainId === Number(req.chainId) && isAddressEqual(s.account, extra.account!))
    : undefined;
  if (snap && req.policy) {
    const diffs: string[] = [];
    for (const k of [
      "capUsdPerDay",
      "perTxMaxUsd",
      "maxFeeWeiPerTx",
      "timelockDelay",
      "timelockThresholdUsd",
    ] as const) {
      const mine = snap.settings[k] ?? snap.reported?.[k];
      const theirs = req.policy[k];
      if (mine !== undefined && theirs !== undefined && BigInt(mine) !== theirs) diffs.push(k);
    }
    for (const t of req.policy.tokens ?? []) {
      const mine = snap.tokens[t.token.toLowerCase()];
      if (mine && mine.usdPerToken !== t.usdPerToken) diffs.push(`price of ${shortAddress(t.token)}`);
    }
    if (diffs.length > 0) {
      warnings.push({
        code: "E-74",
        title: "Your account's settings changed since this phone last signed.",
        body: "Check them in the browser before approving.",
      });
    }
  }

  // Advisory intent (key 11): compared, never shown.
  const mismatch: string[] = [];
  const intent = req.intent;
  if (intent && primary) {
    if (intent.action && intent.action.toLowerCase() !== primary.action.toLowerCase() && intent.action !== primary.id)
      mismatch.push("action");
    const cmp = primary.compare;
    if (intent.recipient && cmp?.recipient && !isAddressEqual(intent.recipient as Address, cmp.recipient))
      mismatch.push("recipient");
    if (intent.amount !== undefined && cmp?.amount !== undefined && intent.amount !== cmp.amount)
      mismatch.push("amount");
    if (intent.token && cmp?.token && !isAddressEqual(intent.token as Address, cmp.token)) mismatch.push("token");
    if ((intent.recipient || intent.amount !== undefined || intent.token) && !cmp) mismatch.push("action");
  }
  if (mismatch.length > 0) {
    warnings.unshift({
      code: "mismatch",
      title: "The browser described this differently",
      body: `It disagreed on the ${joinWords([...new Set(mismatch)])}. What you see on this phone is what you'd sign.`,
    });
  }

  return {
    kind,
    request: req,
    digest,
    needsPayerSig: extra.needsPayerSig,
    ...(extra.sigIndex !== undefined ? { sigIndex: extra.sigIndex } : {}),
    headline,
    ...(admin ? { admin } : {}),
    actions,
    warnings: dedupe(warnings),
    mismatch: [...new Set(mismatch)],
    unknown,
    approval: unknown ? "unknown" : mismatch.length > 0 ? "anyway" : "normal",
    structure,
    recoveryMode: ctx.mode === "recovery",
  };
}

function dedupe(ws: Warning[]): Warning[] {
  const seen = new Set<string>();
  return ws.filter((w) => (seen.has(w.code) ? false : (seen.add(w.code), true)));
}

function joinWords(ws: string[]): string {
  if (ws.length <= 1) return ws.join("");
  return `${ws.slice(0, -1).join(", ")} and ${ws.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot update after signing
// ---------------------------------------------------------------------------------------------------------------

/**
 * Records what this phone just signed: immediately-effective limit/timelock/token changes become the account's
 * snapshot values (queued ones do not: they may be cancelled). Returns a new snapshot list.
 */
export function updateSnapshots(review: Review, snapshots: AccountSnapshot[], now: number): AccountSnapshot[] {
  const account = review.structure.account;
  if (review.kind !== "frameTx" || !account) return snapshots;
  const chainId = Number(review.structure.chainId);
  const existing = snapshots.find((s) => s.chainId === chainId && isAddressEqual(s.account, account));
  const next: AccountSnapshot = existing
    ? {
        ...existing,
        settings: { ...existing.settings },
        tokens: { ...existing.tokens },
        signers: [...existing.signers],
      }
    : { account, chainId, signers: [], settings: {}, tokens: {}, updatedAt: now };
  if (review.structure.sender && !next.signers.some((s) => isAddressEqual(s, review.structure.sender!)))
    next.signers.push(review.structure.sender);
  // Remember what the browser reported at signing time, kept apart from `settings` (which only ever holds values
  // this phone signed): a lie on the first approval must not become the trusted "from" value of the next one.
  const pol = review.request.policy;
  if (pol) {
    const reported = { ...next.reported };
    for (const k of [
      "capUsdPerDay",
      "perTxMaxUsd",
      "maxFeeWeiPerTx",
      "timelockDelay",
      "timelockThresholdUsd",
    ] as const) {
      if (pol[k] !== undefined) reported[k] = pol[k];
    }
    next.reported = reported;
  }
  const payload = decodeAccountCalls(review);
  for (const c of payload) {
    if (c.queued) continue;
    const a = c.args;
    switch (c.name) {
      case "vaultSetCap":
        next.settings.capUsdPerDay = a.capUsdPerDay as bigint;
        next.settings.perTxMaxUsd = a.perTxMaxUsd as bigint;
        next.settings.maxFeeWeiPerTx = a.maxFeeWeiPerTx as bigint;
        next.settings.maxHotFrames = Number(a.maxHotFrames);
        break;
      case "vaultSetTimelock":
        next.settings.timelockDelay = BigInt(a.delay as number | bigint);
        next.settings.timelockThresholdUsd = a.thresholdUsd as bigint;
        break;
      case "vaultSetToken":
        next.tokens[String(a.token).toLowerCase()] = {
          allowed: a.allowed as boolean,
          decimals: Number(a.decimals),
          usdPerToken: a.usdPerToken as bigint,
          signedAt: now,
        };
        break;
    }
  }
  next.updatedAt = now;
  return [...snapshots.filter((s) => s !== existing), next];
}

/** The account-level calls of a reviewed frame tx, flattened (for the snapshot). */
function decodeAccountCalls(review: Review): { name: string; args: Record<string, unknown>; queued: boolean }[] {
  const out: { name: string; args: Record<string, unknown>; queued: boolean }[] = [];
  const profile = review.request.profileId ? profiles[review.request.profileId] : undefined;
  const account = review.structure.account;
  if (!profile || !account) return out;
  const tx = decodeTx(profile, review.request.payload);
  const f1 = tx.frames[1];
  if (!f1) return out;
  const outer = lookup("roleSigner", f1.data);
  if (!outer) return out;
  const { data } = decodeArgs(outer, f1.data) as { data: Hex };
  const top = lookup("account", data);
  if (!top) return out;
  const args = decodeArgs(top, data);
  if (top.format?.kind === "container") {
    const queued = top.format.timing === "waitingPeriod";
    for (const c of (args.calls as { target: Address; data: Hex }[]) ?? []) {
      if (!isAddressEqual(c.target, account)) continue;
      const e = lookup("account", c.data);
      if (e) out.push({ name: e.item.name, args: decodeArgs(e, c.data), queued });
    }
  } else {
    out.push({ name: top.item.name, args, queued: false });
  }
  return out;
}

export type { AbiFunction, FormatSpec };
export const ACCOUNT_ABI = abiOf("account");
export const ROLE_SIGNER_ABI = abiOf("roleSigner");
export const ERC20_ABI = abiOf("erc20");

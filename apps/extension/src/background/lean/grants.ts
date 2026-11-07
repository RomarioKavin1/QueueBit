import { getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import type { Grant, GrantSpec } from "@queuebit/account";

/** What the web app's delegate page (it does not run the engine) uses from the SDK. */
export {
  buildDelegatePayment,
  checkGrantPayment,
  delegateNonceKey,
  findGrants,
  grantPaymentCall,
  laneNonce,
  paymentFees,
  submit,
  type Call,
  type Grant,
} from "@queuebit/account";

/**
 * Spending permissions ("grants"): the owner lets someone else's wallet (MetaMask or any browser wallet, an EIP712
 * session key) spend from this account within limits until a time. The chain is the record (readGrant/listGrants in
 * @queuebit/account): nothing is kept here, so a grant shows the same on every device.
 *
 * The Spending permissions page asks for one asset at a time; a second asset for the same person joins their grant
 * (one key per person), and the end time applies to all of it.
 */

/** What the page asks for (amounts as the person typed them, in whole ETH or whole tokens). */
export interface GrantRequest {
  chainId?: number;
  delegate: Address;
  /** "ETH", or a token's contract address. */
  asset: "ETH" | Address;
  perPayment: string;
  perDay: string;
  /** Unix seconds. */
  validUntil: number;
  /** ETH only: who they may pay (an ETH grant can't be "anyone": see @queuebit/account grants.ts). */
  recipients?: Address[];
}

/** A grant as the pages show it (JSON-safe: amounts in the smallest unit, as decimal strings). */
export interface GrantView {
  account: Address;
  delegate: Address;
  keyId: Hex;
  validUntil: number;
  assets: GrantAssetView[];
}

export interface GrantAssetView {
  asset: "ETH" | Address;
  symbol: string;
  decimals: number;
  perPayment: string;
  perDay: string;
  spentToday: string;
  leftToday: string;
  /** ETH: the only addresses it may go to. Tokens: absent (any recipient). */
  recipients?: Address[];
}

export interface TokenMeta {
  token: Address;
  symbol: string;
  decimals: number;
}

const ETH_META = { symbol: "ETH", decimals: 18 };
export const MAX_GRANT_DAYS = 365;

function amount(v: string, decimals: number, what: string): bigint {
  const t = v.trim();
  if (!/^\d+(\.\d+)?$/u.test(t)) throw new Error(`Enter the ${what} as a number.`);
  if ((t.split(".")[1] ?? "").length > decimals) throw new Error(`At most ${decimals} decimals.`);
  return parseUnits(t, decimals);
}

/**
 * The grant to put on chain (pure): what the person already has (`current`, from the chain) with the asset this
 * request sets replaced or added, and the request's end time for all of it.
 */
export function mergeGrantSpec(
  current: Grant | undefined,
  req: GrantRequest,
  tokens: readonly TokenMeta[],
  nowSec: number,
): GrantSpec {
  if (!isAddress(req.delegate, { strict: false }))
    throw new Error("Enter the wallet address of the person you're letting spend (0x + 40 characters).");
  if (req.validUntil > nowSec + MAX_GRANT_DAYS * 86_400) throw new Error(`At most ${MAX_GRANT_DAYS} days.`);
  const active = current?.active ? current : undefined;
  const spec: GrantSpec = {
    delegate: getAddress(req.delegate),
    validUntil: req.validUntil,
    ...(active?.eth
      ? {
          eth: { perPayment: active.eth.perPayment, perDay: active.eth.perDay, recipients: active.eth.recipients },
        }
      : {}),
    tokens: (active?.tokens ?? []).map((t) => ({ token: t.token, perPayment: t.perPayment, perDay: t.perDay })),
  };
  if (req.asset === "ETH") {
    const recipients = (req.recipients ?? []).map((r) => r.trim()).filter(Boolean);
    for (const r of recipients) if (!isAddress(r, { strict: false })) throw new Error(`${r} isn't an address.`);
    spec.eth = {
      perPayment: amount(req.perPayment, 18, "per-payment limit"),
      perDay: amount(req.perDay, 18, "daily limit"),
      recipients: [...new Set(recipients.map((r) => getAddress(r)))],
    };
  } else {
    const meta = tokens.find((t) => t.token.toLowerCase() === req.asset.toLowerCase());
    if (!meta) throw new Error("Pick a token from the list.");
    const t = {
      token: meta.token,
      perPayment: amount(req.perPayment, meta.decimals, "per-payment limit"),
      perDay: amount(req.perDay, meta.decimals, "daily limit"),
    };
    spec.tokens = [...spec.tokens.filter((x) => x.token.toLowerCase() !== meta.token.toLowerCase()), t];
  }
  return spec;
}

/** A grant for the pages (pure). Tokens not in `tokens` show by address with 18 decimals. */
export function grantView(g: Grant, tokens: readonly TokenMeta[]): GrantView {
  const assets: GrantAssetView[] = [];
  if (g.eth)
    assets.push({
      asset: "ETH",
      ...ETH_META,
      perPayment: g.eth.perPayment.toString(),
      perDay: g.eth.perDay.toString(),
      spentToday: g.eth.spentToday.toString(),
      leftToday: g.eth.leftToday.toString(),
      recipients: g.eth.recipients,
    });
  for (const t of g.tokens) {
    const meta = tokens.find((x) => x.token.toLowerCase() === t.token.toLowerCase());
    assets.push({
      asset: t.token,
      symbol: meta?.symbol ?? `${t.token.slice(0, 6)}…${t.token.slice(-4)}`,
      decimals: meta?.decimals ?? 18,
      perPayment: t.perPayment.toString(),
      perDay: t.perDay.toString(),
      spentToday: t.spentToday.toString(),
      leftToday: t.leftToday.toString(),
    });
  }
  return { account: g.account, delegate: g.delegate, keyId: g.keyId, validUntil: g.validUntil, assets };
}

/**
 * One line in plain words: "Up to 0.05 ETH a day, 0.01 per payment, until Fri 5 pm". `fmt` formats an amount in the
 * smallest unit; `until` is the end time as the page writes it.
 */
export function grantSentence(
  a: Pick<GrantAssetView, "symbol" | "perPayment" | "perDay" | "recipients">,
  fmt: (v: string) => string,
  until: string,
): string {
  const to = a.recipients
    ? a.recipients.length === 1
      ? ", only to 1 address"
      : `, only to ${a.recipients.length} addresses`
    : ", to anyone";
  return `Up to ${fmt(a.perDay)} ${a.symbol} a day, ${fmt(a.perPayment)} per payment${to}, until ${until}`;
}

/** The link a delegate opens: /delegate?account=… */
export const delegateLink = (origin: string, account: Address): string =>
  `${origin.replace(/\/+$/u, "")}/delegate?account=${account}`;

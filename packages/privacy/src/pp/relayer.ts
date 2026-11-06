import { getAddress, isAddressEqual, isHex, type Address, type Hex } from "viem";
import type { Network } from "../host/types.js";
import { assertRelayFee } from "../guardrails.js";
import { decodeRelayData, type RelayData, type Withdrawal } from "./crypto.js";
import type { ProveResult } from "./prover.js";

/**
 * The 0xbow relayer mode (plan §1.3 "mode: relayer"): a *third-party* relayer (0xbow's `packages/relayer`, routes
 * `/relayer/details`, `/relayer/quote`, `/relayer/request`) submits `Entrypoint.relay(...)` with
 * `processooor = Entrypoint` and keeps its signed BPS fee. QueueBit is only a client: it sets no fee, runs no relayer
 * (§7 rule 1) and talks to the relayer through the Host `network` (Anon-RPC).
 */

export class RelayerError extends Error {
  constructor(why: string) {
    super(`Relayer: ${why}`);
    this.name = "RelayerError";
  }
}

export interface RelayerQuote {
  baseFeeBPS: bigint;
  feeBPS: bigint;
  gasPrice: bigint;
  feeCommitment?: {
    expiration: number;
    withdrawalData: Hex;
    amount: string;
    extraGas: boolean;
    signedRelayerCommitment: Hex;
  };
}

export interface RelayerResult {
  success: boolean;
  requestId?: string;
  txHash?: Hex;
  error?: string;
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  throw new RelayerError(`bad ${what}`);
};

export class RelayerClient {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly network: Network,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.network.fetch(this.base + path, init);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new RelayerError(`${path}: HTTP ${res.status} without JSON`);
    }
    if (!res.ok) throw new RelayerError(`${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  }

  details(chainId: bigint, asset: Address): Promise<unknown> {
    return this.json(`/relayer/details?chainId=${chainId}&assetAddress=${getAddress(asset)}`);
  }

  async quote(q: { chainId: bigint; amount: bigint; asset: Address; recipient: Address }): Promise<RelayerQuote> {
    const r = (await this.json("/relayer/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: Number(q.chainId),
        amount: q.amount.toString(),
        asset: getAddress(q.asset),
        recipient: getAddress(q.recipient),
        extraGas: false,
      }),
    })) as Record<string, unknown>;
    const fc = r.feeCommitment as Record<string, unknown> | undefined;
    if (fc && (!isHex(fc.withdrawalData) || !isHex(fc.signedRelayerCommitment))) {
      throw new RelayerError("malformed fee commitment");
    }
    return {
      baseFeeBPS: big(r.baseFeeBPS, "baseFeeBPS"),
      feeBPS: big(r.feeBPS, "feeBPS"),
      gasPrice: big(r.gasPrice, "gasPrice"),
      ...(fc
        ? {
            feeCommitment: {
              expiration: Number(fc.expiration),
              withdrawalData: fc.withdrawalData as Hex,
              amount: String(fc.amount),
              extraGas: Boolean(fc.extraGas),
              signedRelayerCommitment: fc.signedRelayerCommitment as Hex,
            },
          }
        : {}),
    };
  }

  async request(a: {
    chainId: bigint;
    scope: bigint;
    asset: Address;
    withdrawal: Withdrawal;
    proof: ProveResult;
    quote: RelayerQuote;
  }): Promise<RelayerResult> {
    const fc = a.quote.feeCommitment;
    const body = {
      withdrawal: a.withdrawal,
      publicSignals: a.proof.publicSignals,
      proof: { pi_a: a.proof.raw.pi_a, pi_b: a.proof.raw.pi_b, pi_c: a.proof.raw.pi_c },
      scope: a.scope.toString(),
      chainId: Number(a.chainId),
      ...(fc ? { feeCommitment: { ...fc, asset: getAddress(a.asset) } } : {}),
    };
    const r = (await this.json("/relayer/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
    return {
      success: r.success === true,
      ...(typeof r.requestId === "string" ? { requestId: r.requestId } : {}),
      ...(isHex(r.txHash) ? { txHash: r.txHash } : {}),
      ...(typeof r.error === "string" ? { error: r.error } : {}),
    };
  }
}

/**
 * The relayer-mode withdrawal the proof binds: the relayer's committed `withdrawalData` (RelayData) as-is, after
 * checking it pays *our* recipient and that its BPS is the quoted one and within the pool's on-chain cap.
 */
export function relayerWithdrawal(a: {
  entrypoint: Address;
  recipient: Address;
  quote: RelayerQuote;
  maxRelayFeeBPS: bigint;
}): { withdrawal: Withdrawal; relay: RelayData } {
  const fc = a.quote.feeCommitment;
  if (!fc) throw new RelayerError("quote has no fee commitment");
  let relay: RelayData;
  try {
    relay = decodeRelayData(fc.withdrawalData);
  } catch {
    throw new RelayerError("fee commitment is not RelayData");
  }
  if (!isAddressEqual(relay.recipient, a.recipient)) throw new RelayerError("fee commitment pays another recipient");
  assertRelayFee({ relayFeeBPS: relay.relayFeeBPS, quotedBPS: a.quote.feeBPS, maxRelayFeeBPS: a.maxRelayFeeBPS });
  return { withdrawal: { processooor: a.entrypoint, data: fc.withdrawalData }, relay };
}

"use client";

/**
 * The delegate's side of a spending permission, in the page (no engine: the person here has no QueueBit wallet, only
 * the browser wallet the owner named). Reads grants from the chain, and sends a payment for the owner's account that
 * the connected wallet signs as EIP-712 typed data; it goes straight to the alt mempool (no LeanPool), and the
 * account pays the fees.
 */
import { createSidecarClient, httpTransport } from "@queuebit/rpc";
import { createPublicClient, http, serializeTypedData, type Address, type Hex } from "viem";
import {
  buildDelegatePayment,
  checkGrantPayment,
  delegateNonceKey,
  findGrants,
  laneNonce,
  paymentFees,
  submit,
  type Call,
  type Grant,
} from "@queuebit/extension/src/background/lean/grants";
import { DEFAULT_CHAIN_ID, getNetwork } from "@queuebit/extension/src/shared/chains";
import { connect, type Injected } from "./injected";

export const net = getNetwork(DEFAULT_CHAIN_ID);
const client = createPublicClient({ transport: http(net.rpcUrl) });
const sidecar = createSidecarClient(httpTransport(net.sidecarUrl));

export const nowSec = () => Math.floor(Date.now() / 1000);

function deployment() {
  if (!net.deployment) throw new Error("QueueBit's account contracts aren't on this network.");
  return net.deployment;
}

/** Every account that lets `delegate` spend (read from the chain now). */
export const grantsFor = (delegate: Address): Promise<Grant[]> => findGrants(client, deployment(), delegate, nowSec());

export const check = (g: Grant, calls: Call[]) => checkGrantPayment(deployment(), g, calls, nowSec());

/**
 * Signs (in the connected wallet) and sends one payment within `g`. Refuses before signing what the account would
 * refuse or revert (checkGrantPayment), so a person never pays a fee for nothing. Throws with a sentence.
 */
export async function payWithin(w: Injected, g: Grant, calls: Call[]): Promise<Hex> {
  const c = check(g, calls);
  if (!c.ok) throw new Error(c.reason);
  const from = await connect(w, net);
  if (from.toLowerCase() !== g.delegate.toLowerCase())
    throw new Error(`Your wallet is on ${from}; this permission is for ${g.delegate}. Switch accounts in your wallet.`);
  const d = deployment();
  const [fees, nonceSeq] = await Promise.all([
    paymentFees(client),
    laneNonce(client, g.account, delegateNonceKey(g.delegate)),
  ]);
  const plan = await buildDelegatePayment({
    d,
    grant: g,
    calls,
    nonceSeq,
    ...fees,
    signTypedData: async (typed) =>
      (await w.provider.request({
        method: "eth_signTypedData_v4",
        params: [from, serializeTypedData(typed)],
      })) as Hex,
  });
  try {
    const sub = await submit(plan, { sidecar });
    if (sub.via !== "alt-mempool") throw new Error("unexpected route");
    return sub.txHash;
  } catch (e) {
    const why = ((e as Error).message ?? String(e)).split("\n")[0] ?? "";
    if (/already held by pending/iu.test(why))
      throw new Error("Your last payment from this account is still settling. Try again in a few seconds.", {
        cause: e,
      });
    throw new Error(`The account refused this payment (${why}). Nothing was sent and nothing was spent.`, {
      cause: e,
    });
  }
}

/**
 * Follows a payment until it is in a block: "mined" (it went through), "reverted" (the account's daily limit or the
 * end time stopped it in execution; the account paid the fee), or "dropped" (the network gave up on it: nothing was
 * spent, send it again).
 */
export async function follow(hash: Hex, timeoutMs = 180_000): Promise<"mined" | "reverted" | "dropped" | "pending"> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = (await client
      .request({ method: "eth_getTransactionReceipt", params: [hash] } as never)
      .catch(() => null)) as { frameReceipts?: { status: Hex }[]; status?: Hex } | null;
    if (r) {
      const frames = r.frameReceipts ?? [];
      const ok = frames.length ? frames.every((f) => BigInt(f.status) === 1n) : BigInt(r.status ?? "0x1") === 1n;
      return ok ? "mined" : "reverted";
    }
    const s = await sidecar.frameTransactionStatus(hash).catch(() => null);
    if (s?.status === "Cancelled") return "dropped";
    await new Promise((res) => setTimeout(res, 2500));
  }
  return "pending";
}

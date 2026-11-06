"use client";

import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { Working } from "@/components/onboarding/ui";
import { eth, short } from "@/lib/format";
import { Row } from "./bits";

interface Proof {
  ok: boolean;
  block: bigint;
  time: number;
  confirmations: bigint;
  from: Address;
  to: Address | null;
  gasUsed: bigint;
  feeWei: bigint;
  /** For account creation: the account's contract code, in bytes (0 = not there). */
  accountCode?: number;
}

/**
 * A transaction, checked against the network's own node instead of an explorer: the receipt, its block, how many
 * blocks came after it and, for account creation, whether the account's contract now lives at the address. This test
 * network has no block explorer for ordinary transactions, so this is the way to see them; the same JSON-RPC calls
 * work from any terminal (shown under "Check it yourself").
 */
export function OnChain({ rpcUrl, hash, account }: { rpcUrl: string; hash: Hex; account?: Address }) {
  const [proof, setProof] = useState<Proof | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "pending" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);

  const check = useCallback(async () => {
    setState("loading");
    setErr(null);
    try {
      const c = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
      const r = await c.getTransactionReceipt({ hash }).catch(() => null);
      if (!r) return setState("pending");
      const [blk, head, code] = await Promise.all([
        c.getBlock({ blockNumber: r.blockNumber }),
        c.getBlockNumber(),
        account ? c.getCode({ address: account }) : Promise.resolve(undefined),
      ]);
      setProof({
        ok: r.status === "success",
        block: r.blockNumber,
        time: Number(blk.timestamp) * 1000,
        confirmations: head - r.blockNumber + 1n,
        from: r.from,
        to: r.to,
        gasUsed: r.gasUsed,
        feeWei: r.gasUsed * r.effectiveGasPrice,
        ...(account ? { accountCode: code && code !== "0x" ? (code.length - 2) / 2 : 0 } : {}),
      });
      setState("ready");
    } catch (e) {
      setErr(e instanceof Error ? e.message.split("\n")[0]! : "The node didn't answer.");
      setState("error");
    }
  }, [rpcUrl, hash, account]);

  useEffect(() => {
    void check();
  }, [check]);

  const host = (() => {
    try {
      return new URL(rpcUrl).host;
    } catch {
      return rpcUrl;
    }
  })();
  const curl = `curl -s ${rpcUrl} -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["${hash}"]}'`;

  return (
    <section className="mt-9">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="mono-label text-ink-2">On the chain</h2>
        <button
          type="button"
          onClick={() => void check()}
          disabled={state === "loading"}
          className="mono-label h-9 text-blue disabled:text-ink-3"
        >
          {state === "loading" ? "Checking…" : "Check again"}
        </button>
      </div>

      <div className="plate-grid relative px-4 py-4">
        <span aria-hidden className="fig-tag absolute top-3 right-2">
          [ RECEIPT ]
        </span>
        {state === "loading" && !proof && (
          <p className="flex items-center gap-3 py-2 mono-label text-ink-3">
            <Working /> Asking the node
          </p>
        )}
        {state === "pending" && (
          <p className="py-1 pr-6 text-[0.98rem] leading-[1.5] text-ink-2">
            The node doesn&apos;t have a receipt yet: the transaction isn&apos;t in a block. Check again in a few
            seconds.
          </p>
        )}
        {state === "error" && (
          <p className="py-1 pr-6 text-[0.98rem] leading-[1.5] text-red">Couldn&apos;t ask the node: {err}</p>
        )}
        {proof && (
          <p className="flex items-center gap-3 pr-6">
            <Verdict ok={proof.ok} />
            <span className="text-[1.02rem] leading-snug">
              {proof.ok ? "Succeeded" : "Reverted"} in block {proof.block.toLocaleString("en-US")}
              <span className="block text-[0.9rem] text-ink-3">
                {new Date(proof.time).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" })} ·{" "}
                {proof.confirmations.toLocaleString("en-US")} confirmation{proof.confirmations === 1n ? "" : "s"}
              </span>
            </span>
          </p>
        )}
      </div>

      {proof && (
        <dl className="mt-4 border-t border-ink">
          <Row k="From">
            <span className="font-mono text-[14px]">{short(proof.from)}</span>
          </Row>
          {proof.to && (
            <Row k="To">
              <span className="font-mono text-[14px]">{short(proof.to)}</span>
            </Row>
          )}
          <Row k="Gas used">{proof.gasUsed.toLocaleString("en-US")}</Row>
          <Row k="Fee paid">{eth(proof.feeWei, 8)} ETH</Row>
          {proof.accountCode !== undefined && account && (
            <Row k="Account contract">
              {proof.accountCode > 0 ? `At ${short(account)} (${proof.accountCode} bytes)` : "Not found"}
            </Row>
          )}
          <Row k="Checked with">{host}</Row>
        </dl>
      )}

      <details className="mt-4">
        <summary className="mono-label cursor-pointer py-2 text-[11px] text-ink-3">Check it yourself</summary>
        <p className="mt-1 text-[0.92rem] leading-[1.55] text-ink-2">
          Ask the network&apos;s node for the receipt from any terminal. <code className="font-mono">status</code>{" "}
          <code className="font-mono">0x1</code> means it succeeded; <code className="font-mono">blockNumber</code> is
          the block, in hex.
        </p>
        <pre className="mt-2 overflow-x-auto border border-rule bg-paper-2 p-3 font-mono text-[11.5px] leading-[1.6]">
          {curl}
        </pre>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(curl.replace("\\\n  ", ""))}
          className="mono-label mt-2 h-10 border border-ink bg-paper px-3 active:bg-paper-3"
        >
          Copy command
        </button>
      </details>
    </section>
  );
}

function Verdict({ ok }: { ok: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={30} height={30} aria-hidden className="shrink-0">
      <circle cx="12" cy="12" r="11" fill="var(--paper)" stroke={ok ? "var(--blue)" : "var(--red)"} strokeWidth="1.3" />
      {ok ? (
        <path d="M7 12.2l3.2 3.2L17 8.6" fill="none" stroke="var(--blue)" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="var(--red)" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  );
}

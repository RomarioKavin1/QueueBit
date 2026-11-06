/** The public devnet's faucet (the alt-mempool gateway): sends test ETH to an address. */
export const PUBLIC_FAUCET = "https://altmempoolgateway.forshtat.com/rpc";

export async function askFaucet(address: string, rpc = PUBLIC_FAUCET): Promise<void> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_faucet", params: [address] }),
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok || body?.error)
    throw new Error(body?.error?.message ?? "The test faucet didn't answer. Try again later.");
}

/** Polls `read` until it reaches `atLeast` (or gives up after `tries`). */
export async function waitForWei(read: () => Promise<bigint>, atLeast: bigint, tries = 30, ms = 2000) {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v >= atLeast) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  return read();
}

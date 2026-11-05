// Fund dev keys from the public devnet's published genesis key (the faucet is often empty). Devnet only.
import { parseEther, type Address } from "viem";
import { KEYS, addr, sendLegacy, waitReceipt, pub } from "./lib.js";
const targets = (process.env.FUND ?? "anvil3,anvil4").split(",") as (keyof typeof KEYS)[];
for (const t of targets) {
  const to = addr(KEYS[t]);
  const h = await sendLegacy(KEYS.devnet, { to, value: parseEther(process.env.AMOUNT ?? "2"), gas: 250_000n });
  const r = await waitReceipt(h);
  console.log(t, to, r.status, (await pub.getBalance({ address: to })).toString());
}

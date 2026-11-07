// The aggregator's two on-chain writes (postRoot, attachProof) when the aggregator identity is a PQAggregator
// contract: read the operation's nonce, sign the EIP-712 digest with the C13 key, and send the signed call from the
// gas-payer EOA. Separated from chain.ts so it runs against a fake contract in tests (test/pqAggregator.test.ts).
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import type { C13Signer } from "./c13.js";
import { PQ_AGGREGATOR_ABI, attachDigest, postDigest } from "./pqAggregator.js";

/** What the PQ path reads from and sends to the chain. */
export interface PQChainIO {
  chainId: number;
  registry: Address;
  aggregator: Address;
  read(fn: "postNonce" | "attachNonce" | "signaturesUsed" | "signatureBudget" | "ADMIN_RESERVE"): Promise<bigint>;
  publicKey(): Promise<Hex>;
  /** DepsRegistry.isPosted(aggregator, root). */
  isPosted(root: Hex): Promise<boolean>;
  /** The proof hash DepsRegistry holds for the aggregator's root (zero when none). */
  proofHashOf(root: Hex): Promise<Hex>;
  /** A legacy tx from the gas payer to the PQAggregator; resolves to the receipt, throws if it reverted. */
  send(
    data: Hex,
  ): Promise<{ transactionHash: Hex; blockNumber: bigint; gasUsed: bigint; logs: { data: Hex; topics: Hex[] }[] }>;
}

/**
 * Signatures this node has produced per C13 public key, kept on disk. The contract counts only the signatures that
 * landed; a signature for a tx that failed still used the few-time key, so the node keeps its own count and refuses
 * once it reaches the contract's post budget (`signatureBudget - ADMIN_RESERVE`): rotate the key before that.
 */
export class SignatureLedger {
  private counts: Record<string, number> = {};
  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) this.counts = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
  }
  used(pk: Hex): number {
    return this.counts[pk.toLowerCase()] ?? 0;
  }
  add(pk: Hex): void {
    this.counts[pk.toLowerCase()] = this.used(pk) + 1;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.counts, null, 2)}\n`);
    }
  }
}

export class BudgetExhausted extends Error {}

export interface PQOps {
  postRoot(
    root: Hex,
    count: number,
    wallets: Address[],
  ): Promise<{ tx: Hex; block: bigint; gasUsed: bigint; logs: { data: Hex; topics: Hex[] }[] }>;
  attachProof(root: Hex, proofHash: Hex): Promise<{ tx: Hex; gasUsed: bigint }>;
  /** Refuses to start when the contract holds another key (the node would only produce reverting posts). */
  check(): Promise<{ signaturesUsed: bigint; budget: bigint; reserve: bigint }>;
}

export function pqOps(io: PQChainIO, signer: C13Signer, ledger: SignatureLedger): PQOps {
  const domain = { chainId: io.chainId, aggregator: io.aggregator };

  const budgetOnChain = async () => {
    const [signaturesUsed, budget, reserve] = await Promise.all([
      io.read("signaturesUsed"),
      io.read("signatureBudget"),
      io.read("ADMIN_RESERVE"),
    ]);
    return { signaturesUsed, budget, reserve };
  };

  async function checkBudget(): Promise<void> {
    const { signaturesUsed: used, budget: total, reserve } = await budgetOnChain();
    const cap = total - reserve;
    if (used >= cap || BigInt(ledger.used(signer.publicKey)) >= cap) {
      throw new BudgetExhausted(
        `C13 signature budget reached (on-chain ${used}, this node ${ledger.used(signer.publicKey)}, posts stop at ${cap}): rotate the PQAggregator key`,
      );
    }
  }

  // The batch loop and the prover loop sign concurrently: the budget check and the count happen one at a time, so
  // the two cannot both take the last signature.
  let counting: Promise<unknown> = Promise.resolve();
  async function signed(digest: Hex): Promise<Hex> {
    const turn = counting.then(async () => {
      await checkBudget();
      ledger.add(signer.publicKey); // counted before signing: a crash mid-signature still counts
    });
    counting = turn.catch(() => {});
    await turn;
    return signer.sign(digest);
  }

  return {
    async check() {
      const pk = await io.publicKey();
      if (pk.toLowerCase() !== signer.publicKey.toLowerCase()) {
        throw new Error(
          `the PQAggregator ${io.aggregator} holds the C13 key ${pk}, not this node's ${signer.publicKey}`,
        );
      }
      return budgetOnChain();
    },
    async postRoot(root, count, wallets) {
      // DepsRegistry refuses a root twice; say so (the node then delivers with the posted root) without signing.
      if (await io.isPosted(root)) throw new Error(`RootExists: ${root} is already posted by ${io.aggregator}`);
      const nonce = await io.read("postNonce");
      const sig = await signed(postDigest(domain, { registry: io.registry, nonce, root, count, wallets }));
      const r = await io.send(
        encodeFunctionData({ abi: PQ_AGGREGATOR_ABI, functionName: "post", args: [root, count, wallets, sig] }),
      );
      return { tx: r.transactionHash, block: r.blockNumber, gasUsed: r.gasUsed, logs: r.logs };
    },
    async attachProof(root, proofHash) {
      // DepsRegistry keeps the first proof hash: an already attached one would only waste a few-time signature.
      const attached = await io.proofHashOf(root);
      if (BigInt(attached) !== 0n) {
        if (attached.toLowerCase() === proofHash.toLowerCase()) return { tx: "0x", gasUsed: 0n };
        throw new Error(`ProofExists: ${root} already has proof hash ${attached}`);
      }
      const nonce = await io.read("attachNonce");
      const sig = await signed(attachDigest(domain, { registry: io.registry, nonce, root, proofHash }));
      const r = await io.send(
        encodeFunctionData({ abi: PQ_AGGREGATOR_ABI, functionName: "attachProof", args: [root, proofHash, sig] }),
      );
      return { tx: r.transactionHash, gasUsed: r.gasUsed };
    },
  };
}

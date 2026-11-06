// JSON-RPC over node:http for a Node8288 (no framework). Methods:
//   leanpool_sendTransaction [{raw, sigs[]}]  → {txHash (LeanPool id), deps}
//   leanpool_getTx [poolId]                   → TxStatus | null
//   leanpool_getStark [proofHash]             → STARK bytes | null
//   leanpool_status []                        → node status
//   leanpool_wrapper [wrapperHex]             → peers: an EIP-8288 wrapper
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Hex } from "viem";
import type { Node8288 } from "./node.js";

export interface ServerOpts {
  node: Node8288;
  maxBodyBytes: number;
  extraStatus?: () => Record<string, unknown>;
  log?: (...a: unknown[]) => void;
}

const isHex = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x);

class BadRequest extends Error {}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new BadRequest(`request body above ${max} bytes`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handle(
  node: Node8288,
  method: string,
  params: unknown[],
  extra?: () => Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "leanpool_sendTransaction": {
      const p = params[0] as { raw?: unknown; sigs?: unknown } | undefined;
      if (!p || !isHex(p.raw) || !Array.isArray(p.sigs) || !p.sigs.every(isHex))
        throw new BadRequest("params: [{raw: hex, sigs: hex[]}]");
      const t = await node.intake(p.raw, p.sigs as Hex[]);
      return { txHash: t.hash, deps: t.deps };
    }
    case "leanpool_getTx":
      if (!isHex(params[0])) throw new BadRequest("params: [poolId]");
      return node.txStatus(params[0]);
    case "leanpool_wrapper":
      if (!isHex(params[0])) throw new BadRequest("params: [wrapper hex]");
      return node.receiveWrapper(params[0]);
    case "leanpool_getStark":
      if (!isHex(params[0])) throw new BadRequest("params: [proofHash]");
      return node.starks.get(params[0].toLowerCase() as Hex) ?? null;
    case "leanpool_status":
      return { ...node.status(), ...(extra?.() ?? {}) };
    default:
      throw new BadRequest(`unknown method ${method}`);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function createRpcServer(o: ServerOpts): Server {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", ...CORS });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method === "GET") {
      // Health check for containers and the extension's "node reachable" hint.
      send(200, { ok: true, name: o.node.status().name });
      return;
    }
    if (req.method !== "POST") return send(405, { error: "POST JSON-RPC" });
    let id: unknown = null;
    try {
      const body = JSON.parse(await readBody(req, o.maxBodyBytes));
      id = body?.id ?? null;
      if (typeof body?.method !== "string")
        return send(200, { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } });
      const result = await handle(o.node, body.method, Array.isArray(body.params) ? body.params : [], o.extraStatus);
      send(200, { jsonrpc: "2.0", id, result });
    } catch (e) {
      const code = e instanceof SyntaxError ? -32700 : e instanceof BadRequest ? -32602 : -32000;
      send(200, { jsonrpc: "2.0", id, error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  });
}

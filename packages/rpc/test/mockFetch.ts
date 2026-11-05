export interface Call {
  url: string;
  method: string;
  params: unknown[];
  id: number;
  headers: Record<string, string>;
}

type Reply = { result: unknown } | { error: { code: unknown; message: string; data?: unknown } } | Response;

/** A `fetch` that answers JSON-RPC requests from `handler` and records them. */
export function mockFetch(handler: (method: string, params: unknown[], url: string) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { jsonrpc: string; id: number; method: string; params: unknown[] };
    if (body.jsonrpc !== "2.0") throw new Error("not JSON-RPC 2.0");
    calls.push({
      url: String(input),
      method: body.method,
      params: body.params,
      id: body.id,
      headers: init?.headers as Record<string, string>,
    });
    const reply = handler(body.method, body.params, String(input));
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

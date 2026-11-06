import { describe, expect, it, vi } from "vitest";

// The service-worker port the bridge opens: echoes every request back as a result.
const swPort = vi.hoisted(() => {
  const listeners: ((m: unknown) => void)[] = [];
  return {
    sent: [] as { id: string; method: string }[],
    port: {
      onMessage: { addListener: (f: (m: unknown) => void) => listeners.push(f) },
      onDisconnect: { addListener: () => undefined },
      postMessage(m: { id: string; method: string }) {
        swPort.sent.push(m);
        queueMicrotask(() => listeners.forEach((f) => f({ id: m.id, result: `ok:${m.method}` })));
      },
    },
  };
});
vi.mock("wxt/browser", () => ({ browser: { runtime: { connect: () => swPort.port } } }));

const { startBridge } = await import("../../src/provider/bridge");
const { QueueBitProvider } = await import("../../src/provider/inpage");

/** A window whose postMessage delivers `{data, source, ports}` to every listener in a later task, like a browser. */
function fakeWindow() {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const win = {
    location: { origin: "https://app.example" },
    top: undefined as unknown,
    addEventListener: (type: string, f: (e: MessageEvent) => void) => type === "message" && listeners.push(f),
    postMessage(data: unknown, _origin: string, transfer: MessagePort[] = []) {
      setTimeout(() => listeners.forEach((f) => f({ data, source: win, ports: transfer } as unknown as MessageEvent)));
    },
  };
  win.top = win;
  return { win, seen: (f: (e: MessageEvent) => void) => listeners.push(f) };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("provider ↔ bridge private channel (M0 review: co-installed extensions)", () => {
  for (const order of ["provider first", "bridge first"] as const) {
    it(`requests and responses never cross window.postMessage (${order})`, async () => {
      const { win, seen } = fakeWindow();
      const onWindow: unknown[] = [];
      seen((e) => onWindow.push(e.data));
      vi.stubGlobal("window", win);
      vi.stubGlobal("location", win.location);
      let provider: InstanceType<typeof QueueBitProvider>;
      if (order === "provider first") {
        provider = new QueueBitProvider(win as unknown as Window);
        startBridge();
      } else {
        startBridge();
        provider = new QueueBitProvider(win as unknown as Window);
      }
      const r = provider.request({ method: "eth_chainId" });
      await expect(r).resolves.toBe("ok:eth_chainId");
      expect(swPort.sent.at(-1)?.method).toBe("eth_chainId");
      // Only the handshake was visible on window: no request, no response, no event.
      for (const d of onWindow) expect(Object.keys(d as object).sort()).not.toContain("request");
      for (const d of onWindow) expect(Object.keys(d as object).sort()).not.toContain("message");
      await tick();
      vi.unstubAllGlobals();
    });
  }

  it("a forged window message cannot answer a request, and a second hello gets no channel", async () => {
    const { win } = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal("location", win.location);
    startBridge();
    const provider = new QueueBitProvider(win as unknown as Window);
    await tick();
    // An attacker says hello with its own nonce: the bridge already handed its one channel to the provider.
    const ports: MessagePort[] = [];
    win.addEventListener("message", (e: MessageEvent) => ports.push(...e.ports));
    win.postMessage({ target: "queuebit-content", hello: "attacker" }, "*");
    await tick();
    expect(ports).toEqual([]);
    // A forged "response" on window for a request id is ignored by the provider.
    const pending = provider.request({ method: "eth_accounts" });
    win.postMessage({ target: "queuebit-inpage", message: { id: "x", result: ["0xevil"] } }, "*");
    await expect(pending).resolves.toBe("ok:eth_accounts");
    await tick();
    vi.unstubAllGlobals();
  });
});

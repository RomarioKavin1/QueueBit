import { beforeAll, describe, expect, it, vi } from "vitest";
import { Wallet } from "../../src/background/wallet";
import { localDeployment } from "../../src/generated/contracts";
import { getNetwork } from "../../src/shared/chains";
import { MemoryKV } from "../../src/shared/kv";
import { priceWarning } from "../../src/pages/app/Onboarding";

vi.mock("../../src/shared/build", () => ({
  LOCAL_DEVNET: true,
  DESIGN_GALLERY: false,
  BUILD: { localDevnet: true, designGallery: false },
}));

/**
 * "Tokens you'll spend": the price is what the account counts the token at, so a price far below the real one
 * loosens the daily limit by that factor. The page warns at 2× either way; the service worker refuses below 1/100 of
 * the preset (and a price that rounds to zero).
 */
let w: Wallet;
beforeAll(async () => {
  w = new Wallet({
    local: new MemoryKV(),
    session: new MemoryKV(),
    windows: { open: async () => 1, focus: async () => true, exists: async () => true },
    readRpc: async () => null,
    getBalance: async () => 0n,
    emit: () => undefined,
    keyring: { scrypt: { N: 2 ** 10, r: 8, p: 1 } },
    now: () => 1_700_000_000_000,
  });
  await w.keyring.create("password-1");
}, 60_000);

const usdc = () => getNetwork(1337).tokenPresets.find((p) => p.symbol === "USDC")!;

describe.skipIf(!localDeployment)("token prices at setup", () => {
  it("refuses a price under 1% of the preset, or one that rounds to zero", async () => {
    const p = usdc();
    const row = { token: p.token, decimals: p.decimals, symbol: p.symbol };
    await expect(
      w.handleUi("setup:setTokens", { chainId: 1337, tokens: [{ ...row, usd: p.usd / 200 }] }),
    ).rejects.toThrow(/under 1%/u);
    await expect(w.handleUi("setup:setTokens", { chainId: 1337, tokens: [{ ...row, usd: 1e-7 }] })).rejects.toThrow(
      /above \$0/u,
    );
  });

  it("accepts a confirmed price near the preset and pins it in USD-6", async () => {
    const p = usdc();
    const setup = await w.handleUi("setup:setTokens", {
      chainId: 1337,
      tokens: [{ token: p.token, decimals: p.decimals, symbol: p.symbol, usd: 0.98 }],
    });
    expect(setup.tokens?.["1337"]).toMatchObject([{ token: p.token, usdPerToken: "980000", decimals: p.decimals }]);
  });

  it("the page warns at half or double the suggested price, not in between", () => {
    const p = usdc();
    expect(priceWarning(p, p.usd)).toBeUndefined();
    expect(priceWarning(p, p.usd * 0.7)).toBeUndefined();
    expect(priceWarning(p, p.usd / 2)).toMatch(/2× more USDC/u);
    expect(priceWarning(p, p.usd / 10)).toMatch(/10× more/u);
    expect(priceWarning(p, p.usd * 3)).toMatch(/fewer USDC/u);
  });
});

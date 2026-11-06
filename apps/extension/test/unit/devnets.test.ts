import { describe, expect, it } from "vitest";
import { publicDeployment } from "../../src/generated/contracts";
import { DEFAULT_LEANPOOL_URL } from "../../src/shared/build";
import {
  DEVNET_CAPABILITIES,
  explorerTxLink,
  findNetwork,
  NETWORKS,
  PUBLIC_EXPLORER_TX,
} from "../../src/shared/chains";

// A normal (store) build: chain 1337 is the public alt-mempool devnet, the only network.
describe("devnet profiles", () => {
  it("the public devnet: frame devnets only, the generated LeanAccount deployment, its explorer, no staged budget", () => {
    expect(NETWORKS.map((n) => n.chainId)).toEqual([1337]);
    const net = findNetwork(1337)!;
    expect(net.rpcUrl).toBe("https://altmempool.forshtat.com");
    expect(net.stakedSidecarUrl).toBeUndefined();
    expect(net.capabilities).toEqual(DEVNET_CAPABILITIES.public);
    expect(net.leanpoolUrl).toBe(DEFAULT_LEANPOOL_URL);
    if (publicDeployment) {
      expect(net.deployment?.factory).toBe(publicDeployment.factory);
      expect(net.deployment?.keystore).toBe(publicDeployment.keystore);
      expect(net.tokens.map((t) => t.symbol)).toEqual(publicDeployment.tokens.map((t) => t.symbol));
    } else expect(net.deployment).toBeUndefined();
    const h = `0x${"ab".repeat(32)}`;
    expect(explorerTxLink(net, h)).toBe(PUBLIC_EXPLORER_TX.replace("{hash}", h));
    expect(explorerTxLink(net, "0x1234")).toBeUndefined();
    expect(findNetwork(31337)).toBeUndefined();
    expect(findNetwork(11155111)).toBeUndefined();
  });
});

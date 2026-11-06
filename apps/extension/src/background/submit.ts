import type { FrameTx } from "@queuebit/frames";
import type { NodeClient, SidecarClient } from "@queuebit/rpc";
import type { Hex } from "viem";
import type { Network } from "../shared/chains";

/**
 * The standard lane's submission. Normally ethrex (`eth_sendRawTransaction`). A devnet whose explorer only knows what
 * its stock sidecar saw (`submitViaSidecar`: the public and the shared devnet, whose Frame pool explorer reads
 * `skandha_explorer_*`) gets the frame transaction through that sidecar (`eth_sendFrameTransaction`, the same flat
 * 100k admission as ethrex; the sidecar forwards it), so the activity's explorer link shows it with its admission
 * report. If the sidecar refuses or is unreachable, ethrex decides as before; an "already known" answer then means
 * the sidecar had forwarded it, so the expected hash stands.
 */
export async function submitStandardLane(o: {
  net: Network;
  raw: Hex;
  tx: FrameTx;
  expectedHash: Hex;
  node: NodeClient;
  sidecar?: ((url: string) => SidecarClient) | undefined;
}): Promise<Hex> {
  if (o.net.submitViaSidecar && o.net.sidecarUrl && o.sidecar) {
    try {
      return await o.sidecar(o.net.sidecarUrl).sendFrameTransaction(o.tx);
    } catch {
      // refused or unreachable: fall through to the node
    }
  }
  try {
    return await o.node.sendRawTransaction(o.raw);
  } catch (e) {
    if (/already known|known transaction|already in (the )?(mempool|pool)/iu.test(String((e as Error)?.message ?? e)))
      return o.expectedHash;
    throw e;
  }
}

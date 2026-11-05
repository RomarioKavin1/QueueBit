import { browser } from "wxt/browser";
import { UI_CHANNEL, type UiApi, type UiMessage, type UiResponse, type UiType } from "../../shared/messages";

export class UiCallError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "UiCallError";
  }
}

/** Typed request to the service worker (the only place keys and state are handled). */
export async function call<K extends UiType>(
  type: K,
  ...[payload]: UiApi[K]["req"] extends undefined ? [] : [UiApi[K]["req"]]
): Promise<UiApi[K]["res"]> {
  const msg: UiMessage<K> = { channel: UI_CHANNEL, type, payload: payload as UiApi[K]["req"] };
  const res = (await browser.runtime.sendMessage(msg)) as UiResponse<K> | undefined;
  if (!res) throw new UiCallError("LEAKED's background service didn't answer. Try again.");
  if (!res.ok) throw new UiCallError(res.error.message, res.error.reason);
  return res.result;
}

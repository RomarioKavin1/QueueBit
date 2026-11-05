import { useEffect, useState } from "react";
import { call } from "../lib/api";

export const approvalId = new URLSearchParams(location.search).get("id") ?? "";

export async function reject() {
  await call("approval:resolve", { id: approvalId, approved: false }).catch(() => undefined);
  window.close();
}

/**
 * The approval window opens focused, at a predictable spot, the moment a page asks. A page that gets the user clicking
 * or pressing Enter repeatedly could land that input on Connect. The primary action therefore stays disabled for a
 * short arming period after the window appears or regains focus (the same guard MetaMask and Rabby apply).
 */
const ARM_DELAY_MS = 500;

export function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(t);
      setArmed(false);
      t = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    };
    arm();
    window.addEventListener("focus", arm);
    return () => {
      clearTimeout(t);
      window.removeEventListener("focus", arm);
    };
  }, []);
  return armed;
}

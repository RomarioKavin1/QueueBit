import type { Metadata } from "next";
import { Onboarding } from "@/components/onboarding/Onboarding";

export const metadata: Metadata = { title: "Start" };

/** Onboarding: passkey, secret phrase, or moving in from the wallet you have. */
export default function Start() {
  return <Onboarding />;
}

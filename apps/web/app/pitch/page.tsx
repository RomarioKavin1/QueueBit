import type { Metadata } from "next";
import { Deck } from "@/components/pitch/Deck";

export const metadata: Metadata = {
  title: "QueueBit · the pitch",
  description: "A quantum-safe account for the wallet you already have, in thirteen slides.",
};

export default function Pitch() {
  return <Deck />;
}

import type { Metadata } from "next";
import { TestHarness } from "@/components/test/TestHarness";

export const metadata: Metadata = { title: "Test harness", robots: { index: false, follow: false } };

export default function TestPage() {
  return <TestHarness />;
}

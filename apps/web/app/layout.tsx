import type { Metadata, Viewport } from "next";
import { EB_Garamond, Exo_2, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "./sw-register";
import "./globals.css";

// Two voices: a book serif for everything a reader reads, and a clean technical mono (Geist Mono) for the wordmark,
// figure labels, readouts and controls.
const garamond = EB_Garamond({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-garamond",
  display: "swap",
});
// The wordmark's face: Exo 2, thin (extra light on the landing, heavier only where it is small).
const display = Exo_2({
  subsets: ["latin"],
  variable: "--font-exo",
  display: "swap",
});
const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-label",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "QueueBit: a quantum-safe account for the wallet you already have", template: "%s · QueueBit" },
  description:
    "QueueBit moves your wallet into an account whose owner key is hash-based, so a quantum computer can't forge it. Start with a passkey.",
  applicationName: "QueueBit",
  appleWebApp: { capable: true, title: "QueueBit", statusBarStyle: "default" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/apple-touch-icon.png" },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: "#fbfbfb",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${garamond.variable} ${display.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}

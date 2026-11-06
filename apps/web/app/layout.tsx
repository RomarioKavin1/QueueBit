import type { Metadata, Viewport } from "next";
import { EB_Garamond } from "next/font/google";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "./sw-register";
import "./globals.css";

// The manual's two voices: a book serif for everything a reader reads, and a pixel mono (Departure Mono, OFL,
// app/fonts/DepartureMono-LICENSE.txt) for the title, figure labels, readouts and controls.
const garamond = EB_Garamond({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-garamond",
  display: "swap",
});
const departure = localFont({
  src: "./fonts/DepartureMono-Regular.woff2",
  variable: "--font-departure",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "QueueBit: a quantum-safe account for the wallet you already have", template: "%s · QueueBit" },
  description:
    "QueueBit moves your wallet into an account whose owner key is hash-based, so a quantum computer can't forge it. Start with a passkey.",
  applicationName: "QueueBit",
  appleWebApp: { capable: true, title: "QueueBit", statusBarStyle: "default" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
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
    <html lang="en" className={`${garamond.variable} ${departure.variable}`}>
      <body className="min-h-screen">
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}

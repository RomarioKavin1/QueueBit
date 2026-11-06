import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "./sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "QueueBit", template: "%s · QueueBit" },
  description: "A wallet whose account is quantum-safe, with sessions for the sites you use.",
  applicationName: "QueueBit",
  appleWebApp: { capable: true, title: "QueueBit", statusBarStyle: "default" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface">
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "QueueBit",
    short_name: "QueueBit",
    description: "A wallet whose account is quantum-safe, with sessions for the sites you use.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfbfb",
    theme_color: "#fbfbfb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}

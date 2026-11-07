import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "QueueBit",
    short_name: "QueueBit",
    description: "A wallet whose account is owned by a quantum-safe key, with sessions for the sites you use.",
    start_url: "/start",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "en",
    dir: "ltr",
    categories: ["finance", "utilities"],
    prefer_related_applications: false,
    background_color: "#fbfbfb",
    theme_color: "#fbfbfb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    // Shown in the install sheet (Chrome's richer install UI needs at least one narrow screenshot).
    screenshots: [
      {
        src: "/screenshots/home.png",
        sizes: "780x1688",
        type: "image/png",
        form_factor: "narrow",
        label: "Home: balance, actions, assets",
      },
      {
        src: "/screenshots/send.png",
        sizes: "780x1688",
        type: "image/png",
        form_factor: "narrow",
        label: "Send: pick who, type how much",
      },
      {
        src: "/screenshots/account.png",
        sizes: "780x1688",
        type: "image/png",
        form_factor: "narrow",
        label: "Settings: name, backup, guardians",
      },
    ],
  };
}

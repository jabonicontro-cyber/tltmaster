import type { MetadataRoute } from "next";
import { PRODUCT_NAME } from "@/lib/product";

/**
 * The installable Taviron app (docs/COMPANION_APP.md). It opens the signed-in home: drivers land on My Day, everyone
 * else on the Command Center (/dashboard decides). Served without sign-in or early access (proxy exemption) because
 * browsers fetch the manifest without cookies; it contains no company data.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: "Your loads, jobs, schedule, messages and time off.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    // Any orientation: phones are used upright, tablets (iPad, Android) often in landscape on a stand or in the shop.
    orientation: "any",
    background_color: "#10233a",
    theme_color: "#10233a",
    icons: [
      { src: "/app-icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/app-icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/app-icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

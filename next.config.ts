import type { NextConfig } from "next";
import { SITE_PAGES } from "./src/lib/site/paths";

const securityHeaders = [
  // Private operational data: never index.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// The public website may be indexed only when SITE_INDEXING=on (read at build
// time). The later rule wins for the same header key. The pages come from the one public list (src/lib/site/paths.ts):
// a copy here once fell behind and told search engines not to index the FAQ, Trust and every area page.
const siteIndexHeaders = process.env.SITE_INDEXING?.trim().toLowerCase() === "on"
  ? SITE_PAGES.map((source) => ({ source, headers: [{ key: "X-Robots-Tag", value: "index, follow" }] }))
  : [];

const nextConfig: NextConfig = {
  // Every page in this app is private and per-user; we render on each request.
  poweredByHeader: false,
  serverExternalPackages: ["@react-pdf/renderer"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Settings → Users moved to People, and My account to My profile (2026-10-14): real HTTP redirects for old links.
  async redirects() {
    return [
      { source: "/settings", has: [{ type: "query", key: "tab", value: "users" }], destination: "/employees?view=access", permanent: false },
      { source: "/settings", has: [{ type: "query", key: "tab", value: "account" }], destination: "/profile", permanent: false },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, ...siteIndexHeaders];
  },
};

export default nextConfig;

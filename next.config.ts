import type { NextConfig } from "next";

const securityHeaders = [
  // Private operational data: never index.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// The public website may be indexed only when SITE_INDEXING=on (read at build
// time). The later rule wins for the same header key.
const SITE_PAGES = ["/", "/platform", "/solutions", "/pricing", "/about", "/contact", "/demo", "/privacy", "/terms"];
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, ...siteIndexHeaders];
  },
};

export default nextConfig;

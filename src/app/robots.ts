import type { MetadataRoute } from "next";
import { SITE_PAGES } from "@/lib/site/paths";
import { siteIndexing } from "@/lib/site/indexing";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";

// The app is private and never indexed. With SITE_INDEXING=on, only the
// public website's pages (exact paths) may be.
export default function robots(): MetadataRoute.Robots {
  if (!siteIndexing()) return { rules: [{ userAgent: "*", disallow: "/" }] };
  // The pages, plus the website's images (product screenshots and the link preview), so search and link previews can show them.
  return { rules: [{ userAgent: "*", allow: [...SITE_PAGES.map((p) => `${p}$`), "/site/", "/og/", "/icon.svg"], disallow: "/" }], sitemap: `${PUBLIC_WEBSITE_URL}/sitemap.xml` };
}

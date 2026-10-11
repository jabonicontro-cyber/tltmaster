import type { MetadataRoute } from "next";
import { SITE_PAGES } from "@/lib/site/paths";
import { siteIndexing } from "@/lib/site/indexing";

// The app is private and never indexed. With SITE_INDEXING=on, only the
// public website's pages (exact paths) may be.
export default function robots(): MetadataRoute.Robots {
  if (!siteIndexing()) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return { rules: [{ userAgent: "*", allow: SITE_PAGES.map((p) => `${p}$`), disallow: "/" }] };
}

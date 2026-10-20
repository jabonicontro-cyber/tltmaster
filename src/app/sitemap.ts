import type { MetadataRoute } from "next";
import { siteIndexing } from "@/lib/site/indexing";
import { SITE_PAGES } from "@/lib/site/paths";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";

// The public website's pages for search engines — only when SITE_INDEXING=on (robots.ts allows the same exact paths).
// Empty otherwise, so a preview or staging deployment lists nothing.
export default function sitemap(): MetadataRoute.Sitemap {
  if (!siteIndexing()) return [];
  return SITE_PAGES.map((p) => ({ url: `${PUBLIC_WEBSITE_URL}${p === "/" ? "" : p}`, changeFrequency: "weekly" as const, priority: p === "/" ? 1 : 0.7 }));
}

import type { Metadata } from "next";

/** The link preview every public page shares (scripts/site/render-og-image.mjs), with the page's own address. */
export const SITE_OPEN_GRAPH = {
  type: "website",
  siteName: "Taviron",
  locale: "en_US",
  images: [{ url: "/og/taviron.png", width: 1200, height: 630, alt: "Taviron: your entire trucking operation, connected. The Command Center of the demo company." }],
} satisfies NonNullable<Metadata["openGraph"]>;

/** A page's Open Graph data: the shared preview plus og:url (its canonical path, made absolute by metadataBase). */
export function siteOpenGraph(path: string): NonNullable<Metadata["openGraph"]> {
  return { ...SITE_OPEN_GRAPH, url: path };
}

/** A search-result description of at most 160 characters: whole sentences where they fit, else cut at a word. */
export function metaDescription(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]+/g) ?? [];
  let out = "";
  for (const s of sentences) {
    if ((out + s).trim().length > max) break;
    out += s;
  }
  if (out.trim().length >= 80) return out.trim();
  return `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

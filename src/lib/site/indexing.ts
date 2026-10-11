/** Search engines may index the public pages only when SITE_INDEXING=on (off by default, e.g. on staging). */
export function siteIndexing(): boolean {
  return (process.env.SITE_INDEXING ?? "").trim().toLowerCase() === "on";
}

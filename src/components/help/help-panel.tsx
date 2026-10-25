"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Dialog as D } from "radix-ui";
import { CircleHelp, Search, X } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { startGuide } from "./guide-player";
import { articlesForPath, searchArticles } from "@/lib/help/search";
import type { HelpArticle } from "@/lib/help/types";

/** What the panel needs from each article the person may read (the full text stays on the server). */
export type HelpIndexEntry = Pick<HelpArticle, "id" | "title" | "summary" | "routes" | "category"> & { taskTitles: string[] };
export type GuideEntry = { id: string; title: string; summary: string; start: string };

const asArticle = (e: HelpIndexEntry): HelpArticle => ({
  ...e, permissions: [], audience: "", whatYouSee: [], tasks: e.taskTitles.map((t) => ({ title: t, steps: [] })), prerequisites: [], troubleshooting: [], next: [], related: [], reviewed: "",
});

/**
 * Help for the page you are on: a header button opening a side panel with this page's articles first, a quick search,
 * the guides for this page, and links to the Help Center and support. Articles are already filtered by permission.
 */
export function HelpPanel({ index, guides }: { index: HelpIndexEntry[]; guides: GuideEntry[] }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const all = useMemo(() => index.map(asArticle), [index]);
  const here = useMemo(() => articlesForPath(all, path), [all, path]);
  const found = q.trim() ? searchArticles(all, q).slice(0, 8) : [];
  const pageGuides = guides.filter((g) => here.length === 0 || g.start === path || here.some((a) => a.routes.some((r) => r === g.start)));
  const shown = q.trim() ? found : here.slice(0, 6);

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger className="inline-flex size-10 items-center justify-center rounded-xl text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-strong" aria-label="Help for this page">
        <CircleHelp className="size-5" aria-hidden />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(26rem,100vw)] flex-col border-l border-line bg-card shadow-xl focus:outline-none">
          <div className="flex h-14 items-center justify-between border-b border-line px-4">
            <D.Title className="text-base font-semibold text-ink">Help</D.Title>
            <D.Close className="rounded-xl p-1 text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-strong" aria-label="Close help">
              <X className="size-5" aria-hidden />
            </D.Close>
          </div>
          <D.Description className="sr-only">Articles and guides for this page, search, and support.</D.Description>
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                setOpen(false);
                router.push(`/help?q=${encodeURIComponent(q.trim())}`);
              }}
            >
              <label htmlFor="help-q" className="sr-only">Search help</label>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
                <input id="help-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help…" className="h-10 w-full rounded-control border border-line bg-card pr-3 pl-9 text-[15px] text-ink" autoComplete="off" />
              </div>
            </form>

            <section aria-labelledby="help-here">
              <h3 id="help-here" className="mb-2 text-sm font-semibold text-muted">{q.trim() ? "Results" : "On this page"}</h3>
              {shown.length ? (
                <ul className="space-y-1">
                  {shown.map((a) => (
                    <li key={a.id}>
                      <Link href={`/help/${a.id}`} onClick={() => setOpen(false)} className="block rounded-xl px-2 py-2 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
                        <span className="block text-[15px] font-semibold text-ink">{a.title}</span>
                        <span className="block text-sm text-muted">{a.summary}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{q.trim() ? "No articles match. Press Enter to search the Help Center, or contact support below." : "No article is written for this page yet. Search above or open the Help Center."}</p>
              )}
            </section>

            {pageGuides.length && !q.trim() ? (
              <section aria-labelledby="help-guides">
                <h3 id="help-guides" className="mb-2 text-sm font-semibold text-muted">Show Me How</h3>
                <ul className="space-y-2">
                  {pageGuides.slice(0, 4).map((g) => (
                    <li key={g.id} className="flex items-start justify-between gap-3 rounded-xl border border-line p-3">
                      <span>
                        <span className="block text-sm font-semibold text-ink">{g.title}</span>
                        <span className="block text-xs text-muted">{g.summary}</span>
                      </span>
                      <button
                        type="button"
                        className={buttonClasses("secondary", "sm", "shrink-0")}
                        onClick={() => {
                          startGuide(g.id);
                          setOpen(false);
                          if (g.start !== path) router.push(g.start);
                        }}
                      >
                        Start
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
          <div className="space-y-2 border-t border-line p-4 text-sm">
            <Link href="/help" onClick={() => setOpen(false)} className="block font-semibold text-brand-fg hover:underline">Open the Help Center</Link>
            <Link href={`/help/contact?from=${encodeURIComponent(path)}`} onClick={() => setOpen(false)} className="block font-semibold text-brand-fg hover:underline">Contact Taviron support</Link>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

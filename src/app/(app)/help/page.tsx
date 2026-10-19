import Link from "next/link";
import { Search } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { HELP_CATEGORIES, type HelpCategory } from "@/lib/help/types";
import { searchArticles } from "@/lib/help/search";
import { requireAccess } from "@/server/auth";
import { helpFor, logHelpSearch } from "@/server/help";
import { GuideStart } from "@/components/help/guide-start";

export const metadata = { title: "Help Center" };

/** Help Center: search, categories and guides, limited to what the person's permissions let them use. */
export default async function HelpCenterPage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string }> }) {
  const access = await requireAccess();
  const sp = await searchParams;
  const { articles, guides } = helpFor(access.permissions);
  const q = (sp.q ?? "").trim().slice(0, 120);
  const results = q ? searchArticles(articles, q) : [];
  if (q) await logHelpSearch(q, results.length).catch(() => undefined);
  const category = (Object.keys(HELP_CATEGORIES) as HelpCategory[]).find((c) => c === sp.category);
  const shown = category ? articles.filter((a) => a.category === category) : articles;
  const byCategory = (Object.keys(HELP_CATEGORIES) as HelpCategory[]).map((c) => ({ c, list: shown.filter((a) => a.category === c) })).filter((x) => x.list.length);

  return (
    <>
      <PageHeader title="Help Center" description="How each part of Taviron works, step by step. You see the articles for the pages your role can open." />
      <form role="search" action="/help" className="mb-6 flex max-w-2xl gap-2">
        <label htmlFor="help-search" className="sr-only">Search help</label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input id="help-search" name="q" defaultValue={q} placeholder="Search, e.g. assign a truck" className="h-10 w-full rounded-md border border-line bg-card pr-3 pl-9 text-[15px] text-ink" />
        </div>
        <button className="h-10 rounded-md bg-strong px-4 text-sm font-semibold text-white">Search</button>
      </form>

      {q ? (
        <section aria-label="Search results" className="mb-8 space-y-3">
          <h2 className="text-lg font-semibold">{results.length ? `${results.length} article${results.length === 1 ? "" : "s"} for “${q}”` : `Nothing found for “${q}”`}</h2>
          {results.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line bg-card">
              {results.map((a) => (
                <li key={a.id}>
                  <Link href={`/help/${a.id}`} className="block px-4 py-3 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
                    <span className="block font-semibold text-ink">{a.title}</span>
                    <span className="block text-sm text-muted">{a.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No article matches" description={<>Try fewer or different words (for example the page name), browse the topics below, or <Link className="font-semibold text-brand-fg underline" href={`/help/contact?from=${encodeURIComponent(`/help?q=${q}`)}`}>contact Taviron support</Link>.</>} />
          )}
        </section>
      ) : null}

      {guides.length ? (
        <section aria-labelledby="guides-heading" className="mb-8">
          <h2 id="guides-heading" className="mb-3 text-lg font-semibold">Show Me How</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {guides.map((g) => (
              <li key={g.id}>
                <Card className="h-full">
                  <CardBody className="flex h-full flex-col gap-2">
                    <span className="font-semibold text-ink">{g.title}</span>
                    <span className="flex-1 text-sm text-muted">{g.summary}</span>
                    <GuideStart id={g.id} href={g.steps[0].href ?? g.steps[0].route.replace(/\/\*$/, "")} />
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav aria-label="Help topics" className="mb-4 flex flex-wrap gap-1.5">
        <Link href="/help" aria-current={!category ? "page" : undefined} className={`rounded-md border px-3 py-1.5 text-sm font-medium ${!category ? "border-strong bg-strong text-white" : "border-line bg-card text-muted hover:text-ink"}`}>All Topics</Link>
        {(Object.entries(HELP_CATEGORIES) as Array<[HelpCategory, string]>).filter(([c]) => articles.some((a) => a.category === c)).map(([c, label]) => (
          <Link key={c} href={`/help?category=${c}`} aria-current={category === c ? "page" : undefined} className={`rounded-md border px-3 py-1.5 text-sm font-medium ${category === c ? "border-strong bg-strong text-white" : "border-line bg-card text-muted hover:text-ink"}`}>{label}</Link>
        ))}
      </nav>
      <div className="grid gap-5 lg:grid-cols-2">
        {byCategory.map(({ c, list }) => (
          <section key={c} aria-labelledby={`cat-${c}`} className="rounded-lg border border-line bg-card">
            <h2 id={`cat-${c}`} className="border-b border-line px-4 py-3 text-base font-semibold">{HELP_CATEGORIES[c]}</h2>
            <ul className="divide-y divide-line">
              {list.map((a) => (
                <li key={a.id}>
                  <Link href={`/help/${a.id}`} className="block px-4 py-2.5 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
                    <span className="block text-[15px] font-medium text-ink">{a.title}</span>
                    <span className="block text-sm text-muted">{a.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-6 text-sm text-muted">
        Did not find it? <Link href="/help/contact?from=/help" className="font-semibold text-brand-fg underline">Contact Taviron support</Link>.
      </p>
    </>
  );
}

import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { QuickSearch } from "@/components/layout/quick-search";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { cleanQuery, searchableGroups } from "@/lib/search";
import { requireAccess } from "@/server/auth";
import { globalSearch } from "@/server/data/global-search";

export const metadata = { title: "Search" };

/** Search everything this person may open: customers, orders, quotes, tickets, fleet and people (by permission). */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const access = await requireAccess();
  const { q: raw } = await searchParams;
  const q = cleanQuery(raw);
  const groups = searchableGroups(access.permissions);
  const results = q ? await globalSearch(access, q) : [];
  return (
    <>
      <PageHeader title="Search" description={groups.length ? `Searches ${groups.map((g) => g.label.toLowerCase()).join(", ")}.` : "Your role has no records to search."} />
      <div className="mb-6">
        {/* Keyed by the submitted query so "See all results" starts a fresh box. */}
        <QuickSearch key={raw ?? ""} variant="page" initialQuery={raw ?? ""} />
      </div>
      {!q ? (
        raw ? <p className="text-sm text-muted">Type at least 2 characters.</p> : null
      ) : results.length === 0 ? (
        <EmptyState title={`Nothing found for “${q}”`} description="Only records you are allowed to open are searched." />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {results.map((g) => (
            <Card key={g.key}>
              <CardHeader title={g.label} />
              <CardBody>
                <ul className="divide-y divide-line">
                  {g.hits.map((h) => (
                    <li key={h.id}>
                      <Link href={h.href} className="block py-2 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
                        <span className="block text-[15px] font-semibold text-ink">{h.title}</span>
                        {h.detail ? <span className="block text-sm text-muted">{h.detail}</span> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

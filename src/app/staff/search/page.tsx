import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { ConsoleSearchBox } from "@/components/admin/console-search";
import { searchHits } from "@/lib/platform/console";
import { consoleSearch } from "@/server/data/console";
import { requirePlatformStaff } from "@/server/platform";

export const metadata = { title: "Search" };

/**
 * One search across the console (PC1): companies and support requests for both staff levels; leads, outreach companies
 * and the team for Admins. The database decides what each level may find.
 */
export default async function ConsoleSearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const me = await requirePlatformStaff();
  const q = String((await searchParams).q ?? "").trim().slice(0, 80);
  const result = q.length >= 2 ? await consoleSearch(q) : null;
  const hits = result?.ok ? searchHits(result.data, me.level) : [];
  const groups = [...new Set(hits.map((h) => h.group))];
  return (
    <>
      <PageHeader
        title="Search"
        description={me.level === "admin" ? "Find a company, a lead, an outreach company, a support request or someone on the team." : "Find a company or a support request."}
        crumbs={[{ label: me.level === "admin" ? "Launchpad" : "Company access", href: me.level === "admin" ? "/admin" : "/staff" }, { label: "Search" }]}
      />
      <ConsoleSearchBox defaultValue={q} className="mb-5 max-w-2xl" />
      {q && q.length < 2 ? (
        <p role="alert" className="text-sm text-ink">Type at least 2 letters.</p>
      ) : result && !result.ok ? (
        <Notice tone={result.reason === "error" ? "warning" : "info"} title="Search">{result.message}</Notice>
      ) : result && hits.length === 0 ? (
        <EmptyState title={`Nothing found for “${q}”`} description="Check the spelling, or search for part of the name." />
      ) : (
        <div className="space-y-5" aria-live="polite">
          {groups.map((g) => (
            <Card key={g}>
              <CardHeader title={g} />
              <ul className="divide-y divide-line" aria-label={g}>
                {hits.filter((h) => h.group === g).map((h) => (
                  <li key={h.href + h.title}>
                    <Link href={h.href} className="block px-5 py-2.5 hover:bg-surface/60 sm:px-6">
                      <span className="block font-semibold break-words text-ink">{h.title}</span>
                      {h.detail ? <span className="block text-sm text-muted">{h.detail}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

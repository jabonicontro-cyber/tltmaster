import { Plus } from "lucide-react";
import { DateInput } from "@/components/ui/date-input";
import { QuoteTable } from "@/components/quotes/quote-table";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";

import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { can } from "@/lib/permissions";
import { QUOTE_STATUS_LABELS, QUOTE_STATUSES } from "@/lib/quotes/status";
import { requirePagePermission } from "@/server/auth";
import { listQuotes } from "@/server/data/quotes";
import { pageParam, PAGE_SIZE } from "@/server/data/search";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Quotes" };

type Search = { q?: string; status?: string; customer?: string; from?: string; to?: string; page?: string };

export default async function QuotesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("quotes.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const [{ rows, total }, { today }] = await Promise.all([
    listQuotes({ q: sp.q, status: sp.status, customer: sp.customer, from: sp.from, to: sp.to, page }),
    businessToday(),
  ]);
  const filtered = Boolean(sp.q || sp.status || sp.customer || sp.from || sp.to);
  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") params.set(k, v);
    params.set("page", String(p));
    return `/quotes?${params}`;
  };

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Every quote with its current revision. Sent revisions are kept unchanged."
        actions={can(access, "quotes.edit") && <ButtonLink href="/quotes/new" icon={<Plus className="size-4" />}>New quote</ButtonLink>}
      />
      <Card>
        <FilterBar action="/quotes" query={sp.q} placeholder="Search quote #, customer, project, site…" clearHref="/quotes">
          {sp.customer && <input type="hidden" name="customer" value={sp.customer} />}
          <FilterSelect
            name="status"
            label="Status"
            value={sp.status}
            options={[{ value: "", label: "All statuses" }, { value: "open", label: "Open (draft + sent)" }, ...QUOTE_STATUSES.map((s) => ({ value: s, label: QUOTE_STATUS_LABELS[s] }))]}
          />
          <div>
            <label htmlFor="from" className="mb-1 block text-xs font-semibold text-muted uppercase">From</label>
            <DateInput id="from" name="from" defaultValue={sp.from} className="w-40" />
          </div>
          <div>
            <label htmlFor="to" className="mb-1 block text-xs font-semibold text-muted uppercase">To</label>
            <DateInput id="to" name="to" defaultValue={sp.to} className="w-40" />
          </div>
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No quotes match these filters" : "No quotes yet"}
            description={filtered ? "Try a different search or clear the filters." : "Create your first quote to get started."}
            action={!filtered && can(access, "quotes.edit") ? <ButtonLink href="/quotes/new">New quote</ButtonLink> : undefined}
          />
        ) : (
          <>
            <QuoteTable rows={rows} today={today} />
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
          </>
        )}
      </Card>
    </>
  );
}

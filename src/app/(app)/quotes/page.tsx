import Link from "next/link";
import { CalendarClock, FilePen, Plus, Send, Trophy } from "lucide-react";
import { StatTile } from "@/components/ui/stat-tile";
import { addDays } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { loadQuoteOutcomes } from "@/server/data/quote-outcomes";
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
import { listQuotes, quotePipeline } from "@/server/data/quotes";
import { pageParam, PAGE_SIZE } from "@/server/data/search";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Quotes" };

type Search = { q?: string; status?: string; customer?: string; from?: string; to?: string; page?: string };

export default async function QuotesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("quotes.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const [{ rows, total }, { today, timezone }] = await Promise.all([
    listQuotes({ q: sp.q, status: sp.status, customer: sp.customer, from: sp.from, to: sp.to, page }),
    businessToday(),
  ]);
  // The figures above the list: open quotes now, and quotes decided in the last 90 days (B95). Left out on failure.
  const [pipe, outcomes] = await Promise.all([
    quotePipeline(today, addDays(today, 7)),
    loadQuoteOutcomes(addDays(today, -89), today, timezone).catch(() => null),
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
      {pipe && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Quotes at a glance">
          <StatTile icon={<FilePen />} label="Drafts" value={pipe.drafts} muted={pipe.drafts === 0}>
            <Link href="/quotes?status=draft" className="text-muted underline-offset-2 hover:underline"><span className="sr-only">{pipe.drafts} </span>not sent yet</Link>
          </StatTile>
          <StatTile icon={<Send />} tone="brand" label="Waiting for an answer" value={pipe.sent} muted={pipe.sent === 0}>
            <Link href="/quotes?status=sent" className="text-muted underline-offset-2 hover:underline"><span className="sr-only">{pipe.sent} sent, </span><span className="tabular">{formatCents(pipe.sentCents)}</span> quoted</Link>
          </StatTile>
          <StatTile icon={<CalendarClock />} tone={pipe.expiring ? "amber" : "neutral"} label="Expiring this week" value={pipe.expiring} muted={pipe.expiring === 0}>
            <span className="text-muted"><span className="sr-only">{pipe.expiring} </span>{pipe.expiring ? "follow up before they lapse" : "nothing lapses in 7 days"}</span>
          </StatTile>
          <StatTile icon={<Trophy />} tone="green" label="Won, last 90 days" value={outcomes?.winRate == null ? "—" : `${Math.round(outcomes.winRate * 100)}%`} muted={!outcomes?.decided}>
            <Link href="/reports" className="text-muted underline-offset-2 hover:underline">{outcomes?.decided ? `${outcomes.won} of ${outcomes.decided} decided` : "no quotes decided yet"}</Link>
          </StatTile>
        </div>
      )}
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
            <label htmlFor="from" className="mb-1 block text-xs font-medium text-muted">From</label>
            <DateInput id="from" name="from" defaultValue={sp.from} className="w-40" />
          </div>
          <div>
            <label htmlFor="to" className="mb-1 block text-xs font-medium text-muted">To</label>
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

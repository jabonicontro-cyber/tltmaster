import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Select } from "@/components/ui/form";
import { EmptyState, Notice } from "@/components/ui/states";
import { formatDay, formatMoment, formatQuantity, quantitiesByUnit } from "@/lib/portal";
import { groupByDay, isFiltered, parseTicketFilter, ticketFilterQuery } from "@/lib/portal-tickets";
import { portalTickets, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Tickets" };

/**
 * The customer's delivery tickets across all their orders (portal_tickets): newest first, grouped by delivery day,
 * filtered by dates and job site, with a CSV of exactly what is shown. Each ticket opens the printable customer copy
 * the portal already has (with its photos once confirmed). Shown only when the company's Documents switch is on.
 */
export default async function PortalTicketsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ from?: string; to?: string; site?: string }> }) {
  const { slug } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/tickets`);
  if (!c.features.documents) notFound();
  const filter = parseTicketFilter(await searchParams, c.sites.map((s) => s.id));
  const result = await portalTickets(slug, filter);
  const base = `/portal/${slug}/tickets`;
  const query = ticketFilterQuery(filter);

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-ink">Delivery tickets</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">Every delivery to you, newest first. Open a ticket to see it, print it or ask us about it.</p>
    </div>
  );
  if (!result.ok && result.reason === "missing") {
    return <div className="space-y-4">{header}<Notice title="Not available yet">The ticket list needs an update on our side. Your tickets are still on each order.</Notice></div>;
  }
  if (!result.ok && result.reason === "refused") notFound();

  const list = result.ok ? result.data : null;
  const rows = list?.tickets ?? [];
  const days = groupByDay(rows);
  const filtered = isFiltered(filter);

  return (
    <div className="space-y-5">
      {header}

      {/* GET form: the filter lives in the address, so a filtered view can be bookmarked and the CSV matches it. */}
      <form method="get" action={base} aria-label="Filter tickets" className="rounded-panel border border-line/70 bg-card p-4 shadow-card sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end">
          <Field label="From" htmlFor="tickets-from">
            <DateInput id="tickets-from" name="from" defaultValue={filter.from ?? ""} max={list?.today} className="h-12 sm:h-10" />
          </Field>
          <Field label="To" htmlFor="tickets-to">
            <DateInput id="tickets-to" name="to" defaultValue={filter.to ?? ""} max={list?.today} className="h-12 sm:h-10" />
          </Field>
          {c.sites.length > 0 ? (
            <Field label="Job site" htmlFor="tickets-site">
              <Select id="tickets-site" name="site" defaultValue={filter.site ?? ""} className="h-12 sm:h-10">
                <option value="">All job sites</option>
                {c.sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </Field>
          ) : <span className="hidden sm:block" />}
          <div className="flex gap-2">
            <button type="submit" className={buttonClasses("primary", "md", "h-12 flex-1 sm:h-10 sm:flex-none")}>Show tickets</button>
            {filtered ? <Link href={base} className={buttonClasses("ghost", "md", "h-12 sm:h-10")}>Clear</Link> : null}
          </div>
        </div>
      </form>

      {!result.ok ? (
        <Notice tone="warning" title="Check the dates">{result.message ?? "Choose a start date before the end date."}</Notice>
      ) : rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No tickets for this filter" : "No delivery tickets yet"}
          description={filtered ? "Try other dates or another job site, or choose Clear to see every ticket." : `Tickets appear here as soon as ${c.name} delivers to you.`}
          action={filtered ? <Link href={base} className={buttonClasses("secondary", "md", "h-12 sm:h-10")}>Clear the filter</Link> : undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink" data-testid="tickets-summary">
              <span className="font-semibold tabular">{rows.length} ticket{rows.length === 1 ? "" : "s"}</span>
              {quantitiesByUnit(rows) ? <span className="text-muted"> · {quantitiesByUnit(rows)}</span> : null}
              {filter.from || filter.to ? <span className="text-muted"> · {filter.from ? formatDay(filter.from) : "Any day"} to {filter.to ? formatDay(filter.to) : "today"}</span> : null}
            </p>
            {/* A plain link: the browser downloads the file the route builds from the same portal function. */}
            <a href={`${base}/csv${query}`} className={buttonClasses("secondary", "md", "h-12 sm:h-10")} download>
              <Download className="size-4" aria-hidden />
              <span>Download CSV</span>
            </a>
          </div>
          {list?.has_more ? (
            <Notice title="Showing the newest 500">Choose a shorter date range to see older tickets. The download has the same 500.</Notice>
          ) : null}

          <div className="space-y-4" aria-label="Tickets">
            {days.map((d) => (
              <section key={d.day} aria-label={formatDay(d.day)}>
                <h2 className="mb-2 flex items-baseline justify-between gap-2 px-1 text-sm font-semibold text-muted">
                  <span>{formatDay(d.day)}</span>
                  <span className="font-normal tabular">{quantitiesByUnit(d.tickets)}</span>
                </h2>
                <ul className="divide-y divide-line/70 overflow-hidden rounded-panel border border-line/70 bg-card shadow-card">
                  {d.tickets.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/portal/${slug}/orders/${t.order_id}/tickets/${t.id}`}
                        className="grid min-h-14 grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong sm:grid-cols-[11rem_1fr_1fr_7rem_8.5rem_1rem]"
                      >
                        <span className="min-w-0">
                          <span className="block font-semibold text-ink tabular">{t.number}</span>
                          <span className="block text-xs whitespace-nowrap text-muted tabular">{formatMoment(t.delivered_at, c.timezone, false)} · Order {t.order_number}</span>
                        </span>
                        <span className="row-start-2 min-w-0 text-sm sm:row-start-auto">
                          <span className="block truncate text-ink">{t.site || "Site not recorded"}</span>
                          {t.project || t.po ? <span className="block truncate text-xs text-muted">{[t.project, t.po ? `PO ${t.po}` : ""].filter(Boolean).join(" · ")}</span> : null}
                        </span>
                        <span className="row-start-3 min-w-0 truncate text-sm text-muted sm:row-start-auto">{t.material || "Material not recorded"}</span>
                        <span className="text-right text-sm font-semibold whitespace-nowrap text-ink tabular">{formatQuantity(t.quantity === null ? null : Number(t.quantity), t.unit.replace(/_/g, " ")) || "–"}</span>
                        <span className="hidden sm:block">
                          <Badge tone={t.confirmed ? "green" : "amber"}>{t.confirmed ? "Confirmed" : "Being checked"}</Badge>
                        </span>
                        <ChevronRight className="hidden size-4 text-muted sm:block" aria-hidden />
                        <span className="col-start-2 row-start-2 justify-self-end sm:hidden">
                          <Badge tone={t.confirmed ? "green" : "amber"}>{t.confirmed ? "Confirmed" : "Being checked"}</Badge>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="text-xs text-muted">&ldquo;Being checked&rdquo; means our office has not confirmed the ticket yet; its quantity can still change.</p>
        </>
      )}
    </div>
  );
}

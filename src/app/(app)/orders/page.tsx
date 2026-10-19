import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, OrderStatusBadge, SampleBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { formatScheduleDates, formatWindow, isPastRequested } from "@/lib/orders/schedule";
import { ORDER_STATUS_LABELS, ORDER_STATUSES } from "@/lib/orders/status";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listOrders, ORDER_SCHEDULE_FILTERS } from "@/server/data/orders";
import { pageParam, PAGE_SIZE } from "@/server/data/search";
import { businessToday } from "@/server/data/settings";

import { baseOptions } from "@/server/data/bases";
import { BaseFilter } from "@/components/bases/base-filter";
export const metadata = { title: "Orders" };

type Search = { q?: string; status?: string; customer?: string; source?: string; when?: string; base?: string; page?: string };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("orders.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  // The base filter applies only where the company has bases to choose from (and the bases update is installed).
  const bases = await baseOptions();
  const [{ rows, total }, { today }] = await Promise.all([
    listOrders({ q: sp.q, status: sp.status, customer: sp.customer, source: sp.source, when: sp.when, base: bases.length > 1 ? sp.base : undefined, page }),
    businessToday(),
  ]);
  const filtered = Boolean(sp.q || sp.status || sp.customer || sp.source || sp.when || sp.base);
  const canCreate = can(access, "orders.edit");
  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") params.set(k, v);
    params.set("page", String(p));
    return `/orders?${params}`;
  };
  const quick = (label: string, params: Record<string, string>) => {
    const active = Object.entries(params).every(([k, v]) => sp[k as keyof Search] === v) && Object.keys(sp).filter((k) => k !== "page" && sp[k as keyof Search]).length === Object.keys(params).length;
    return (
      <Link
        key={label}
        href={`/orders?${new URLSearchParams(params)}`}
        className={`rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-inset ${active ? "bg-strong text-white ring-strong" : "bg-card text-ink ring-line hover:bg-surface"}`}
        aria-current={active ? "true" : undefined}
      >
        {label}
      </Link>
    );
  };

  return (
    <>
      <PageHeader
        title="Orders"
        description="Work the customer has committed to — from accepted quotes or entered directly. Schedule them and track them through delivery."
        actions={canCreate && <ButtonLink href="/orders/new" icon={<Plus className="size-4" />}>New order</ButtonLink>}
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3 sm:px-5" aria-label="Quick filters">
          {quick("Open", { status: "open" })}
          {quick("Scheduled today", { when: "today" })}
          {quick("Next 7 days", { when: "week" })}
          {quick("Not scheduled", { when: "unscheduled" })}
          {quick("Drafts", { status: "draft" })}
          {quick("On hold", { status: "on_hold" })}
        </div>
        <FilterBar action="/orders" query={sp.q} placeholder="Search order #, quote #, customer, contact, project, site, PO, material…" clearHref="/orders">
          {sp.customer && <input type="hidden" name="customer" value={sp.customer} />}
          <FilterSelect
            name="status"
            label="Status"
            value={sp.status}
            options={[{ value: "", label: "All statuses" }, { value: "open", label: "Open (not completed or canceled)" }, ...ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] }))]}
          />
          <FilterSelect
            name="when"
            label="Schedule"
            value={sp.when}
            options={[{ value: "", label: "Any date" }, ...Object.entries(ORDER_SCHEDULE_FILTERS).map(([value, label]) => ({ value, label }))]}
          />
          <FilterSelect
            name="source"
            label="Source"
            value={sp.source}
            options={[
              { value: "", label: "All orders" },
              { value: "quote", label: "From a quote" },
              { value: "direct", label: "Direct orders" },
            ]}
          />
          <BaseFilter bases={bases} value={sp.base} />
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No orders match these filters" : "No orders yet"}
            description={filtered ? "Try a different search or clear the filters." : "Convert an accepted quote, or create a direct order for work that does not need a quote."}
            action={!filtered && canCreate ? <ButtonLink href="/orders/new">New order</ButtonLink> : undefined}
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Customer</Th>
                    <Th className="hidden md:table-cell">Job site / materials</Th>
                    <Th className="hidden sm:table-cell">Delivery</Th>
                    <Th className="hidden lg:table-cell">Source</Th>
                    <Th>Status</Th>
                    <Th align="right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => {
                    const scheduled = formatScheduleDates(o.scheduled_start, o.scheduled_end);
                    const window = formatWindow(o.window_start, o.window_end);
                    const late = isPastRequested(o, today);
                    return (
                      <Tr key={o.id}>
                        <Td>
                          <Link href={`/orders/${o.id}`} className="font-semibold whitespace-nowrap tabular hover:text-brand-fg hover:underline">
                            {o.order_number}
                          </Link>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
                            <span>{formatDate(o.order_date)}</span>
                            {o.customer_po && <span>PO {o.customer_po}</span>}
                            <SampleBadge show={o.is_sample} />
                          </div>
                        </Td>
                        <Td>
                          <Link href={`/customers/${o.customer_id}`} className="hover:underline">{o.customer_name}</Link>
                          {o.contact_name && <div className="text-sm text-muted">{o.contact_name}</div>}
                        </Td>
                        <Td className="hidden max-w-xs md:table-cell">
                          <div className="truncate">{o.project_name || o.site_label || o.site_line1 || <span className="text-muted">—</span>}</div>
                          {(o.site_city || o.material_summary) && (
                            <div className="truncate text-sm text-muted" title={o.material_summary ?? undefined}>
                              {[o.site_city, o.material_summary].filter(Boolean).join(" · ")}
                            </div>
                          )}
                        </Td>
                        <Td className="hidden whitespace-nowrap sm:table-cell">
                          {scheduled ? (
                            <>
                              <div className="font-medium">{scheduled}</div>
                              {window && <div className="text-sm text-muted">{window}</div>}
                            </>
                          ) : o.requested_date ? (
                            <div className="text-sm">
                              <span className="text-muted">Requested</span> {formatDate(o.requested_date)}
                            </div>
                          ) : (
                            <span className="text-sm text-muted">Not scheduled</span>
                          )}
                          {late && (
                            <div className="mt-1">
                              <Badge tone="amber">{scheduled ? "After requested date" : "Requested date passed"}</Badge>
                            </div>
                          )}
                        </Td>
                        <Td className="hidden tabular lg:table-cell">
                          {o.source_quote_id ? (
                            o.source_quote_number ? <Link href={`/quotes/${o.source_quote_id}`} className="hover:underline">{o.source_quote_number}</Link> : "Quote"
                          ) : (
                            <span className="text-muted">Direct</span>
                          )}
                        </Td>
                        <Td>
                          <OrderStatusBadge status={o.status} />
                          {o.status === "on_hold" && o.status_note && <div className="mt-1 max-w-40 truncate text-xs text-muted" title={o.status_note}>{o.status_note}</div>}
                        </Td>
                        <Td align="right" className="font-semibold whitespace-nowrap">{formatCents(o.total_cents)}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
          </>
        )}
      </Card>
    </>
  );
}

import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { CalendarClock, CalendarDays, CalendarX, CirclePause, ClipboardList, FilePen, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, OrderStatusBadge, SampleBadge, UrgentPill } from "@/components/ui/badge";
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
import { listOpenUrgencies } from "@/server/data/urgency";
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
  const base = bases.length > 1 ? sp.base : undefined;
  // The views across the top, each with its count (redesign 2026-10-26: tiles instead of a row of chips).
  const VIEWS = [
    { label: "Open", params: { status: "open" }, icon: ClipboardList },
    { label: "Today", params: { when: "today" }, icon: CalendarDays },
    { label: "Next 7 days", params: { when: "week" }, icon: CalendarClock },
    { label: "Not scheduled", params: { when: "unscheduled" }, icon: CalendarX, attention: true },
    { label: "Drafts", params: { status: "draft" }, icon: FilePen },
    { label: "On hold", params: { status: "on_hold" }, icon: CirclePause, attention: true },
  ] as const;
  const [{ rows, total }, { today }, urgencies, counts] = await Promise.all([
    listOrders({ q: sp.q, status: sp.status, customer: sp.customer, source: sp.source, when: sp.when, base, page }),
    businessToday(),
    listOpenUrgencies(),
    Promise.all(VIEWS.map((v) => listOrders({ ...v.params, base, page: 1, countOnly: true }).then((r) => r.total).catch(() => null))),
  ]);
  // Orders with an open urgent flag get the red edge (owner 2026-10-26); if flags cannot be read, rows stay plain.
  const urgentIds = new Set((urgencies ?? []).map((u) => u.order_id));
  const filtered = Boolean(sp.q || sp.status || sp.customer || sp.source || sp.when || sp.base);
  const canCreate = can(access, "orders.edit");
  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") params.set(k, v);
    params.set("page", String(p));
    return `/orders?${params}`;
  };
  const isActive = (params: Record<string, string>) =>
    Object.entries(params).every(([k, v]) => sp[k as keyof Search] === v) && Object.keys(sp).filter((k) => k !== "page" && k !== "base" && sp[k as keyof Search]).length === Object.keys(params).length;
  const viewHref = (params: Record<string, string>) => `/orders?${new URLSearchParams({ ...params, ...(base ? { base } : {}) })}`;

  return (
    <>
      <PageHeader
        title="Orders"
        description="Work the customer has committed to — from accepted quotes or entered directly. Schedule them and track them through delivery."
        actions={canCreate && <ButtonLink href="/orders/new" icon={<Plus className="size-4" />} data-guide="orders-new">New order</ButtonLink>}
      />
      <nav aria-label="Quick filters" className="mb-5 grid grid-cols-3 gap-2 sm:gap-3 xl:grid-cols-6">
        {VIEWS.map((v, i) => {
          const active = isActive(v.params);
          const n = counts[i];
          const Icon = v.icon;
          return (
            <Link
              key={v.label}
              href={viewHref(v.params)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "group flex flex-col gap-3 rounded-2xl border p-3 shadow-card transition-[transform,background-color] active:scale-[0.98] sm:rounded-panel sm:p-4",
                active ? "border-strong bg-strong text-white" : "border-line/70 bg-card text-ink hover:bg-surface",
              )}
            >
              <span className={cn("hidden size-9 place-items-center rounded-xl sm:grid", active ? "bg-white/15 text-white" : "bg-surface text-ink")}>
                <Icon className="size-4.5" aria-hidden />
              </span>
              <span>
                <span className={cn("block text-xl font-semibold tabular sm:text-2xl", !active && "attention" in v && n ? "text-amber-800" : undefined)}>{n ?? "—"}</span>
                <span className={cn("block truncate text-xs sm:text-sm", active ? "text-white/80" : "text-muted")}>{v.label}</span>
              </span>
            </Link>
          );
        })}
      </nav>
      <Card>
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
            {/* Phones: one card per order (the table needs more width than a phone has). */}
            <ul className="divide-y divide-line sm:hidden" aria-label="Orders">
              {rows.map((o) => {
                const scheduled = formatScheduleDates(o.scheduled_start, o.scheduled_end);
                const urgent = urgentIds.has(o.id);
                return (
                  <li key={o.id} className={cn("relative px-5 py-3.5", urgent && "shadow-[inset_3px_0_0_var(--color-critical)]")}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={`/orders/${o.id}`} className="font-semibold tabular text-ink after:absolute after:inset-0">{o.order_number}</Link>
                        {urgent && <span className="ml-2 align-[1px]"><UrgentPill /></span>}
                        <p className="truncate text-sm text-ink">{o.customer_name}</p>
                      </div>
                      <OrderStatusBadge status={o.status} />
                    </div>
                    <p className="mt-1 truncate text-sm text-muted">{[o.project_name || o.site_label || o.site_line1, o.material_summary].filter(Boolean).join(" · ") || "—"}</p>
                    <div className="mt-1 flex items-center justify-between gap-3 text-sm">
                      <span className={scheduled ? "text-ink" : "text-muted"}>{scheduled || "Not scheduled"}</span>
                      <span className="font-semibold tabular">{formatCents(o.total_cents)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <TableWrap className="hidden sm:block">
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
                    const urgent = urgentIds.has(o.id);
                    return (
                      <Tr key={o.id}>
                        <Td className={urgent ? "shadow-[inset_3px_0_0_var(--color-critical)]" : undefined}>
                          <Link href={`/orders/${o.id}`} className="font-semibold whitespace-nowrap tabular hover:text-brand-fg hover:underline">
                            {o.order_number}
                          </Link>
                          {urgent && <span className="ml-2 align-[1px]"><UrgentPill /></span>}
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
                            <span className="whitespace-nowrap">{formatDate(o.order_date)}</span>
                            {o.customer_po && <span>PO {o.customer_po}</span>}
                            <SampleBadge show={o.is_sample} />
                          </div>
                        </Td>
                        <Td>
                          <Link href={`/customers/${o.customer_id}`} className="flex items-start gap-2.5 hover:underline"><Avatar name={o.customer_name} size={28} className="mt-[-2px] shrink-0" /><span className="min-w-0">{o.customer_name}</span></Link>
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

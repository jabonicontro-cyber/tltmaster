import Link from "next/link";
import { OrderStatusBadge, SampleBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { ORDER_STATUS_LABELS, ORDER_STATUSES } from "@/lib/orders/status";
import { requirePagePermission } from "@/server/auth";
import { listOrders } from "@/server/data/orders";
import { pageParam, PAGE_SIZE } from "@/server/data/search";

export const metadata = { title: "Orders" };

type Search = { q?: string; status?: string; customer?: string; page?: string };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePagePermission("orders.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const { rows, total } = await listOrders({ q: sp.q, status: sp.status, customer: sp.customer, page });
  const filtered = Boolean(sp.q || sp.status || sp.customer);
  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") params.set(k, v);
    params.set("page", String(p));
    return `/orders?${params}`;
  };

  return (
    <>
      <PageHeader
        title="Orders"
        description="Work the customer has committed to. Orders are created from accepted quotes; scheduling, dispatch and tickets come next."
      />
      <Card>
        <FilterBar action="/orders" query={sp.q} placeholder="Search order #, quote #, customer, project, site, PO…" clearHref="/orders">
          {sp.customer && <input type="hidden" name="customer" value={sp.customer} />}
          <FilterSelect
            name="status"
            label="Status"
            value={sp.status}
            options={[{ value: "", label: "All statuses" }, ...ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] }))]}
          />
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No orders match these filters" : "No orders yet"}
            description={filtered ? "Try a different search or clear the filters." : "Open an accepted quote and choose “Convert to order”."}
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Customer</Th>
                    <Th className="hidden md:table-cell">Job site / project</Th>
                    <Th className="hidden sm:table-cell">From quote</Th>
                    <Th>Status</Th>
                    <Th align="right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <Tr key={o.id}>
                      <Td>
                        <Link href={`/orders/${o.id}`} className="font-semibold tabular hover:text-brand hover:underline">
                          {o.order_number}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                          <span>{formatDate(o.created_at.slice(0, 10))}</span>
                          {o.customer_po && <span>· PO {o.customer_po}</span>}
                          <SampleBadge show={o.is_sample} />
                        </div>
                      </Td>
                      <Td>
                        <Link href={`/customers/${o.customer_id}`} className="hover:underline">{o.customer_name}</Link>
                      </Td>
                      <Td className="hidden md:table-cell">
                        <div>{o.project_name || o.site_label || o.site_line1 || <span className="text-muted">—</span>}</div>
                        {o.site_city && <div className="text-sm text-muted">{o.site_city}</div>}
                      </Td>
                      <Td className="hidden tabular sm:table-cell">
                        {o.source_quote_id && o.source_quote_number ? (
                          <Link href={`/quotes/${o.source_quote_id}`} className="hover:underline">{o.source_quote_number}</Link>
                        ) : (
                          <span className="text-muted">Direct</span>
                        )}
                      </Td>
                      <Td><OrderStatusBadge status={o.status} /></Td>
                      <Td align="right" className="font-semibold whitespace-nowrap">{formatCents(o.total_cents)}</Td>
                    </Tr>
                  ))}
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

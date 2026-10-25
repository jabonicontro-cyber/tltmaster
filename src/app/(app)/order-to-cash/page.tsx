import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatCents } from "@/lib/money";
import { lifecycle, OWNERS, STAGE_LABELS, STAGES, summarize, waitingDays, type Stage } from "@/lib/order-to-cash";
import { requirePagePermission } from "@/server/auth";
import { orderToCashRows } from "@/server/data/order-to-cash";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Order to cash" };

type Search = { stage?: string; show?: string; q?: string };
const LIMIT = 200;

export default async function OrderToCashPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePagePermission("billing.view");
  const sp = await searchParams;
  const [rows, { today }] = await Promise.all([orderToCashRows(), businessToday()]);
  const stage = (STAGES as readonly string[]).includes(sp.stage ?? "") ? (sp.stage as Stage) : null;
  const show = sp.show === "all" ? "all" : "attention";
  const q = (sp.q ?? "").trim().toLowerCase();
  const summary = summarize(rows);
  const listed = rows
    .map((o) => ({ o, l: lifecycle(o), days: waitingDays(o, today) }))
    .filter((x) => (!stage || x.l.stage === stage) && (show === "all" || x.l.attention))
    .filter((x) => !q || `${x.o.order_number} ${x.o.customer_name ?? ""} ${x.o.project_name ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => STAGES.indexOf(a.l.stage) - STAGES.indexOf(b.l.stage) || (b.days ?? 0) - (a.days ?? 0));
  const attention = summary.reduce((s, x) => s + x.attention, 0);

  return (
    <>
      <PageHeader
        title="Order to cash"
        description="Every open order from confirmation to billing: where it is, what needs attention, why, and which team acts next. Read from the same records as Orders, Dispatch, Tickets and Billing — nothing here changes an order."
      />
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" aria-label="Stages">
        {summary.map((s) => (
          <li key={s.stage}>
            <Link
              href={`/order-to-cash?stage=${s.stage}&show=all`}
              aria-current={stage === s.stage ? "true" : undefined}
              className="block rounded-panel border border-line/70 bg-card shadow-card px-3 py-2.5 hover:border-strong aria-[current=true]:border-strong"
            >
              <span className="block text-xs font-medium text-muted">{STAGE_LABELS[s.stage]}</span>
              <span className="mt-0.5 block text-2xl font-semibold tabular">{s.total}</span>
              <span className="block text-xs text-muted">{s.attention ? `${s.attention} need attention` : "Nothing waiting"} · {formatCents(s.cents)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* A limit, stated once and quietly: the view ends at Handed off. */}
      <p className="mt-2.5 text-sm text-muted">
        <span className="font-medium text-ink">Coming soon:</span> invoices and payments. Taviron hands orders off for billing; issuing
        invoices, tracking what customers owe and recording payments are not built yet, so this view ends at Handed off.
      </p>

      <Card className="mt-5">
        <CardHeader
          title={stage ? STAGE_LABELS[stage] : show === "attention" ? "Needs attention" : "All open orders"}
          description={show === "attention" ? `${attention} order${attention === 1 ? "" : "s"} need someone to act. Oldest first within each stage.` : "Every open order, by stage."}
        />
        <FilterBar action="/order-to-cash" clearHref="/order-to-cash" placeholder="Search order, customer or project…" query={sp.q}>
          <FilterSelect name="stage" label="Stage" value={stage ?? ""} options={[{ value: "", label: "All stages" }, ...STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))]} />
          <FilterSelect name="show" label="Show" value={show} options={[{ value: "attention", label: "Needs attention" }, { value: "all", label: "Everything" }]} />
        </FilterBar>
        {listed.length === 0 ? (
          <EmptyState title={show === "attention" ? "Nothing needs attention" : "No orders match"} description={show === "attention" ? "Every open order is moving on its own. Show everything to see where each one is." : undefined} />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr><Th>Order</Th><Th>Stage</Th><Th className="hidden md:table-cell">Why</Th><Th>Next step</Th><Th className="hidden sm:table-cell">Team</Th><Th className="hidden text-right lg:table-cell">Waiting</Th></tr>
              </thead>
              <tbody>
                {listed.slice(0, LIMIT).map(({ o, l, days }) => (
                  <Tr key={o.order_id}>
                    <Td>
                      <Link href={`/orders/${o.order_id}`} className="font-semibold hover:underline">{o.order_number}</Link>
                      <span className="block max-w-[14rem] truncate text-xs text-muted">{o.customer_name ?? "—"}{o.project_name ? ` · ${o.project_name}` : ""}</span>
                    </Td>
                    <Td><Badge tone={l.attention ? "amber" : "gray"}>{STAGE_LABELS[l.stage]}</Badge></Td>
                    <Td className="hidden max-w-sm text-sm md:table-cell">{l.why}</Td>
                    <Td><Link href={l.href} className="text-sm font-medium text-brand-fg hover:underline">{l.next}</Link></Td>
                    <Td className="hidden text-sm sm:table-cell">{OWNERS[l.owner]}</Td>
                    <Td className="hidden text-right text-sm tabular lg:table-cell">{days === null ? "—" : `${days} d`}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        {listed.length > LIMIT && <p className="px-5 py-3 text-sm text-muted sm:px-6">Showing the first {LIMIT} of {listed.length}. Filter by stage or search to narrow the list.</p>}
      </Card>
    </>
  );
}

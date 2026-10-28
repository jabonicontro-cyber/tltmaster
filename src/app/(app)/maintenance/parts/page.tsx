import Link from "next/link";
import { Boxes, CircleDollarSign, PackageX } from "lucide-react";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { CountButton, PartDialogButton, ReceiveButton } from "@/components/maintenance/parts-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { isLow, listParts, partCosts, recentMovements } from "@/server/data/parts";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Parts" };

const KIND_LABEL = { received: "Received", used: "Used", adjusted: "Counted" } as const;
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * Shop parts inventory (B105, migration 20261120004500): what is on the shelf, what runs low, and every stock change.
 * maintenance.manage adds, receives and counts; costs appear only with maintenance.costs.
 */
export default async function PartsPage({ searchParams }: { searchParams: Promise<{ low?: string }> }) {
  const access = await requirePagePermission("maintenance.view");
  const sp = await searchParams;
  const manage = can(access, "maintenance.manage");
  const canCosts = can(access, "maintenance.costs");
  const [{ installed, parts }, costs, movements, names, { timezone }] = await Promise.all([
    listParts(), canCosts ? partCosts() : Promise.resolve(new Map()), recentMovements(25), getUserNames(), businessToday(),
  ]);
  const active = parts.filter((p) => p.active);
  const low = active.filter(isLow);
  const shown = sp.low === "1" ? low : active;
  const value = [...costs.values()].reduce((n, c) => n + (c.value ?? 0), 0);
  const byId = new Map(parts.map((p) => [p.id, p]));

  return (
    <>
      <PageHeader title="Maintenance" description="Shop work, preventive maintenance and returning trucks to service." actions={manage && installed && <PartDialogButton />} />
      <MaintenanceTabs active="parts" />
      {!installed ? (
        <Notice title="Not available yet">Parts inventory needs a database update that has not been installed yet.</Notice>
      ) : (
        <>
          <div className={canCosts ? "mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3" : "mb-5 grid grid-cols-2 gap-3"} aria-label="Parts at a glance">
            <StatTile icon={<Boxes />} tone="brand" label="Parts" value={active.length} muted={active.length === 0}>
              <span className="text-muted"><span className="sr-only">{active.length} </span>on the shelf list</span>
            </StatTile>
            <StatTile icon={<PackageX />} tone={low.length ? "amber" : "neutral"} label="Low stock" value={low.length} muted={low.length === 0}>
              {low.length ? <Link href="/maintenance/parts?low=1" className="font-semibold text-amber-700 underline-offset-2 hover:underline"><span className="sr-only">{low.length} </span>at or below reorder point</Link> : <span className="text-muted">nothing to reorder</span>}
            </StatTile>
            {canCosts && (
              <StatTile icon={<CircleDollarSign />} label="Stock value" value={formatCents(value).replace(/\.\d\d$/, "")} muted={value === 0}>
                <span className="text-muted">at the latest received cost</span>
              </StatTile>
            )}
          </div>
          <Card className="mb-5">
            <CardHeader title={sp.low === "1" ? "Low stock" : "Parts"} actions={sp.low === "1" ? <Link href="/maintenance/parts" className="text-sm font-semibold underline">Show all</Link> : undefined} />
            {shown.length === 0 ? (
              <EmptyState title={sp.low === "1" ? "Nothing is low" : "No parts yet"} description={manage ? "Add the parts you keep on the shelf, then receive stock." : "Parts appear here when the shop adds them."} />
            ) : (
              <TableWrap>
                <Table aria-label="Parts">
                  <thead>
                    <tr><Th>Part</Th><Th className="hidden md:table-cell">Location</Th><Th align="right">On hand</Th><Th align="right" className="hidden sm:table-cell">Reorder at</Th>{canCosts && <Th align="right" className="hidden lg:table-cell">Unit cost</Th>}{manage && <Th align="right"><span className="sr-only">Actions</span></Th>}</tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => {
                      const c = costs.get(p.id);
                      return (
                        <Tr key={p.id}>
                          <Td>
                            <span className="font-medium">{p.name}</span>
                            {p.part_number && <span className="ml-2 text-sm text-muted tabular">{p.part_number}</span>}
                            {isLow(p) && <Badge tone="amber" className="ml-2">Low</Badge>}
                          </Td>
                          <Td className="hidden text-sm md:table-cell">{p.location || "—"}</Td>
                          <Td align="right" className="font-semibold tabular">{qty(p.on_hand)} <span className="font-normal text-muted">{p.unit}</span></Td>
                          <Td align="right" className="hidden tabular sm:table-cell">{p.reorder_point ? qty(p.reorder_point) : "—"}</Td>
                          {canCosts && <Td align="right" className="hidden tabular lg:table-cell">{c?.unit != null ? formatCents(c.unit) : "—"}</Td>}
                          {manage && (
                            <Td align="right">
                              <span className="inline-flex flex-wrap justify-end gap-1">
                                <ReceiveButton part={p} canCosts={canCosts} />
                                <CountButton part={p} />
                                <PartDialogButton part={p} label="Edit" variant="ghost" />
                              </span>
                            </Td>
                          )}
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
          <Card>
            <CardHeader title="Recent stock changes" />
            {movements.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted sm:px-6">No stock changes yet.</p>
            ) : (
              <ul className="divide-y divide-line border-t border-line" aria-label="Recent stock changes">
                {movements.map((m) => {
                  const p = byId.get(m.part_id);
                  return (
                    <li key={m.id} className="flex flex-wrap items-baseline gap-x-3 px-5 py-2.5 text-sm sm:px-6">
                      <span className="font-medium">{KIND_LABEL[m.kind]}</span>
                      <span className="tabular">{m.quantity > 0 ? "+" : ""}{qty(m.quantity)} {p?.unit}</span>
                      <span>{p?.name ?? "Part"}</span>
                      {m.work_order_id && <Link href={`/maintenance/work-orders/${m.work_order_id}`} className="text-brand-fg hover:underline">work order</Link>}
                      {m.note && <span className="text-muted">· {m.note}</span>}
                      <span className="ml-auto text-xs text-muted">{formatDateTime(m.created_at, timezone)} · {m.created_by ? names[m.created_by] ?? "Former user" : "System"}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}

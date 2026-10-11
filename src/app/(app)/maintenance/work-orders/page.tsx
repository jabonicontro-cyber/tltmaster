import Link from "next/link";
import { Plus } from "lucide-react";
import { SafetyBadge, UrgencyBadge, WoStatusBadge } from "@/components/maintenance/bits";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { WO_CATEGORIES, WO_STATUSES, WO_URGENCIES } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listAssignees, listTrucks, listWorkOrders } from "@/server/data/maintenance";
import { pageParam, PAGE_SIZE } from "@/server/data/search";

export const metadata = { title: "Work orders" };

type Search = { q?: string; view?: string; status?: string; urgency?: string; category?: string; truck?: string; assigned?: string; page?: string };

const VIEWS = [
  { value: "open", label: "Open" },
  { value: "immediate", label: "Immediate / safety" },
  { value: "clearance", label: "Awaiting inspection" },
  { value: "closed", label: "Completed, closed, canceled" },
  { value: "all", label: "All" },
];

export default async function WorkOrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("maintenance.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const [{ rows, total }, trucks, assignees] = await Promise.all([
    listWorkOrders({ ...sp, page }), listTrucks(), listAssignees(),
  ]);
  const unit = new Map(trucks.map((t) => [t.id, t.unit_number]));
  const names = new Map(assignees.map((a) => [a.id, a.name]));
  const filtered = Boolean(sp.q || sp.status || sp.urgency || sp.category || sp.truck || sp.assigned || (sp.view && sp.view !== "open"));
  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const k of ["q", "view", "status", "urgency", "category", "truck", "assigned"] as const) if (sp[k]) params.set(k, sp[k]!);
    params.set("page", String(p));
    return `/maintenance/work-orders?${params}`;
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: "Work orders" }]}
        title="Work orders"
        actions={can(access, "maintenance.manage") && <ButtonLink href="/maintenance/work-orders/new" icon={<Plus className="size-4" />}>New work order</ButtonLink>}
      />
      <MaintenanceTabs active="work-orders" />
      <Card>
        <FilterBar action="/maintenance/work-orders" query={sp.q} placeholder="Search number, title or truck…" clearHref="/maintenance/work-orders">
          <FilterSelect name="view" label="Show" value={sp.view ?? "open"} options={VIEWS} />
          <FilterSelect name="status" label="Status" value={sp.status ?? ""} options={[{ value: "", label: "Any status" }, ...Object.entries(WO_STATUSES).map(([value, label]) => ({ value, label }))]} />
          <FilterSelect name="urgency" label="Urgency" value={sp.urgency ?? ""} options={[{ value: "", label: "Any urgency" }, ...Object.entries(WO_URGENCIES).map(([value, label]) => ({ value, label }))]} />
          <FilterSelect name="category" label="Category" value={sp.category ?? ""} options={[{ value: "", label: "Any category" }, ...Object.entries(WO_CATEGORIES).map(([value, label]) => ({ value, label }))]} />
          <FilterSelect name="truck" label="Truck" value={sp.truck ?? ""} options={[{ value: "", label: "Any truck" }, ...trucks.map((t) => ({ value: t.id, label: t.unit_number }))]} />
          <FilterSelect name="assigned" label="Mechanic" value={sp.assigned ?? ""} options={[{ value: "", label: "Anyone" }, { value: "none", label: "Unassigned" }, ...assignees.map((a) => ({ value: a.id, label: a.name }))]} />
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No work orders match these filters" : "No open work orders"}
            description={filtered ? "Try a different search or clear the filters." : "Create one for a repair or inspection, or generate due preventive services."}
            action={!filtered && can(access, "maintenance.manage") ? <ButtonLink href="/maintenance/work-orders/new">New work order</ButtonLink> : undefined}
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Work order</Th>
                    <Th>Truck</Th>
                    <Th className="hidden md:table-cell">Urgency</Th>
                    <Th className="hidden lg:table-cell">Mechanic</Th>
                    <Th className="hidden lg:table-cell">Scheduled</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => (
                    <Tr key={w.id}>
                      <Td>
                        <Link href={`/maintenance/work-orders/${w.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{w.number}</Link>
                        <div className="text-sm text-muted">{w.title}</div>
                        {w.safety_critical && <div className="mt-1"><SafetyBadge /></div>}
                      </Td>
                      <Td className="tabular">{unit.get(w.truck_id) ?? "—"}</Td>
                      <Td className="hidden md:table-cell"><UrgencyBadge urgency={w.urgency} /></Td>
                      <Td className="hidden text-sm lg:table-cell">{w.assigned_to ? names.get(w.assigned_to) ?? "Former member" : <span className="text-muted">Unassigned</span>}</Td>
                      <Td className="hidden text-sm lg:table-cell">{w.scheduled_for ? formatDate(w.scheduled_for) : "—"}</Td>
                      <Td><WoStatusBadge status={w.status} /></Td>
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

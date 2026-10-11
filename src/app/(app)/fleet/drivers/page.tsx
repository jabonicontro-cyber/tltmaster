import Link from "next/link";
import { Plus, UserRound } from "lucide-react";
import { ReadinessBadge } from "@/components/fleet/fleet-badges";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { eligibilityMessage } from "@/lib/fleet/eligibility";
import { qualificationName } from "@/lib/fleet/labels";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listDrivers } from "@/server/data/fleet";

export const metadata = { title: "Drivers" };

type Search = { q?: string; status?: string };

export default async function DriversPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("fleet.view");
  const sp = await searchParams;
  const { rows, today } = await listDrivers(sp);
  const canEdit = can(access, "fleet.edit");
  const filtered = Boolean(sp.q || sp.status);

  return (
    <>
      <PageHeader
        title="Fleet"
        description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work."
        actions={canEdit && <ButtonLink href="/fleet/drivers/new" icon={<Plus className="size-4" />}>Add driver</ButtonLink>}
      />
      <FleetNav active="Drivers" />
      <Card>
        <FilterBar action="/fleet/drivers" query={sp.q} placeholder="Search name, employee #, phone…" clearHref="/fleet/drivers">
          <FilterSelect
            name="status"
            label="Status"
            value={sp.status}
            options={[
              { value: "", label: "Active" },
              { value: "ready", label: "Eligible today" },
              { value: "not_ready", label: "Not eligible today" },
              { value: "inactive", label: "Inactive" },
              { value: "all", label: "All" },
            ]}
          />
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            icon={<UserRound className="size-6" />}
            title={filtered ? "No drivers match these filters" : "No drivers yet"}
            description={filtered ? "Try a different search or clear the filters." : "Add drivers, then record each one's CDL and DOT medical card."}
            action={!filtered && canEdit ? <ButtonLink href="/fleet/drivers/new" icon={<Plus className="size-4" />}>Add driver</ButtonLink> : undefined}
          />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Driver</Th>
                  <Th className="hidden md:table-cell">Qualifications</Th>
                  <Th>Eligible today ({formatDate(today)})</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <Tr key={d.id}>
                    <Td>
                      <Link href={`/fleet/drivers/${d.id}`} className="font-semibold hover:text-brand-fg hover:underline">{d.display_name}</Link>
                      <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
                        {d.employee_number && <span>#{d.employee_number}</span>}
                        {d.phone && <span>{d.phone}</span>}
                        {d.user_id && <Badge tone="blue">Has login</Badge>}
                        {!d.active && <Badge tone="gray">Inactive</Badge>}
                      </div>
                    </Td>
                    <Td className="hidden md:table-cell">
                      {d.qualifications.length === 0 ? (
                        <span className="text-muted">None recorded</span>
                      ) : (
                        <span>{[...new Set(d.qualifications.map(qualificationName))].join(", ")}</span>
                      )}
                    </Td>
                    <Td>
                      <ReadinessBadge readiness={d.readiness} />
                      {[...d.readiness.blockers, ...d.readiness.warnings].slice(0, 2).map((c) => (
                        <div key={c} className="mt-1 text-xs text-muted">{eligibilityMessage(c)}</div>
                      ))}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

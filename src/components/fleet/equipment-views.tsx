import Link from "next/link";
import { Plus, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { BaseFilter } from "@/components/bases/base-filter";
import type { BaseOption } from "@/components/bases/base-field";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { SERVICE_STATUS_LABELS, TRAILER_TYPE_LABELS, TRUCK_TYPE_LABELS, TRUCK_TYPES } from "@/lib/fleet/labels";
import type { AuditEventRow, EquipmentStatusEventRow, TrailerRow, TruckRow } from "@/server/data/types";
import { maskVin, OWNERSHIP, type Availability, type Ownership } from "@/lib/fleet/availability";
import { CapacityText, ServiceStatusBadge } from "./fleet-badges";
import { AvailabilityBadge } from "./fleet-status";

type Kind = "truck" | "trailer";
type Equipment = TruckRow | TrailerRow;

const typeLabel = (e: Equipment) => ("truck_type" in e ? TRUCK_TYPE_LABELS[e.truck_type] : TRAILER_TYPE_LABELS[(e as TrailerRow).trailer_type]);

export interface EquipmentRowExtra {
  driver?: string | null;
  availability?: Availability;
  maintenance?: { text: string; tone: "red" | "amber" | "gray" } | null;
  documents?: { expired: number; expiring: number; notRecorded: string[] } | null;
}

export interface EquipmentListFilters {
  q?: string;
  status?: string;
  type?: string;
  driver?: string;
  maintenance?: string;
  documents?: string;
  ownership?: string;
  sort?: string;
  base?: string;
}

export function EquipmentList({
  kind,
  rows,
  filters,
  typeOptions,
  canEdit,
  extras = {},
  sources = { maintenance: false, documents: false },
  bases,
}: {
  kind: Kind;
  rows: Equipment[];
  filters: EquipmentListFilters;
  typeOptions: Array<{ value: string; label: string }>;
  canEdit: boolean;
  extras?: Record<string, EquipmentRowExtra>;
  /** Which optional sources could be read (tables installed and permitted). */
  sources?: { maintenance: boolean; documents: boolean };
  /** Active dispatch bases, for the Base filter (two or more). */
  bases?: BaseOption[];
}) {
  const base = `/fleet/${kind}s`;
  const noun = kind === "truck" ? "truck" : "trailer";
  const filtered = Boolean(filters.q || filters.status || filters.type || filters.driver || filters.maintenance || filters.documents || filters.ownership || filters.base);
  return (
    <Card>
      <FilterBar action={base} query={filters.q} placeholder="Search unit #, make, model, plate, VIN…" clearHref={base}>
        <FilterSelect
          name="status"
          label="Status"
          value={filters.status}
          options={[
            { value: "", label: "Active" },
            { value: "in_service", label: "In service" },
            { value: "out_of_service", label: "Out of service" },
            { value: "inactive", label: "Inactive" },
            { value: "all", label: "All" },
          ]}
        />
        <BaseFilter bases={bases} value={filters.base} />
        <FilterSelect name="type" label="Type" value={filters.type} options={[{ value: "", label: "All types" }, ...typeOptions]} />
        {kind === "truck" && (
          <FilterSelect name="driver" label="Driver" value={filters.driver} options={[{ value: "", label: "Any" }, { value: "assigned", label: "Has a driver" }, { value: "unassigned", label: "No driver" }]} />
        )}
        {kind === "truck" && sources.maintenance && (
          <FilterSelect name="maintenance" label="Maintenance" value={filters.maintenance} options={[
            { value: "", label: "Any" },
            { value: "restricted", label: "Safety restricted / awaiting clearance" },
            { value: "open", label: "Open work orders" },
            { value: "overdue", label: "Preventive overdue" },
            { value: "due_soon", label: "Preventive due soon" },
          ]} />
        )}
        {sources.documents && (
          <FilterSelect name="documents" label="Documents" value={filters.documents} options={[
            { value: "", label: "Any" },
            { value: "attention", label: "Expired or expiring" },
            { value: "expired", label: "Expired" },
            { value: "missing", label: "Registration or insurance not recorded" },
          ]} />
        )}
        <FilterSelect name="ownership" label="Ownership" value={filters.ownership} options={[{ value: "", label: "Any" }, ...Object.entries(OWNERSHIP).map(([value, label]) => ({ value, label })), { value: "unknown", label: "Not recorded" }]} />
        <FilterSelect name="sort" label="Sort" value={filters.sort} options={[
          { value: "", label: "Unit number" },
          { value: "type", label: "Type" },
          { value: "year", label: "Newest first" },
          { value: "status", label: "Least available first" },
        ]} />
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState
          icon={<Truck className="size-6" />}
          title={filtered ? `No ${noun}s match these filters` : `No ${noun}s yet`}
          description={filtered ? "Try a different search or clear the filters." : `Add each ${noun} with its unit number. Capacities can be added once confirmed.`}
          action={!filtered && canEdit ? <ButtonLink href={`${base}/new`} icon={<Plus className="size-4" />}>Add {noun}</ButtonLink> : undefined}
        />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th className="hidden sm:table-cell">Type</Th>
                <Th className="hidden md:table-cell">Year / make / model</Th>
                {kind === "truck" && <Th className="hidden lg:table-cell">Driver</Th>}
                <Th className="hidden xl:table-cell">Capacity</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Needs attention</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const x = extras[e.id] ?? {};
                return (
                  <Tr key={e.id}>
                    <Td>
                      <Link href={`${base}/${e.id}`} className="font-semibold whitespace-nowrap tabular hover:text-brand-fg hover:underline">
                        {e.unit_number}
                      </Link>
                      {e.license_plate && <div className="text-sm text-muted">{[e.plate_state, e.license_plate].filter(Boolean).join(" ")}</div>}
                      {e.vin && <div className="text-xs text-muted tabular" title="Last 6 characters of the VIN">VIN {maskVin(e.vin)}</div>}
                    </Td>
                    <Td className="hidden sm:table-cell">{typeLabel(e)}</Td>
                    <Td className="hidden md:table-cell">
                      {[e.model_year, e.make, e.model].filter(Boolean).join(" ") || <span className="text-muted">—</span>}
                      {"ownership" in e && e.ownership ? <div className="text-xs text-muted">{OWNERSHIP[e.ownership as Ownership]}</div> : null}
                    </Td>
                    {kind === "truck" && <Td className="hidden lg:table-cell">{x.driver ?? <span className="text-muted">—</span>}</Td>}
                    <Td className="hidden xl:table-cell"><CapacityText e={e} /></Td>
                    <Td>
                      {x.availability ? <AvailabilityBadge a={x.availability} /> : <ServiceStatusBadge status={e.service_status} active={e.active} />}
                      {e.active && e.service_status === "out_of_service" && (
                        <div className="mt-1 max-w-56 truncate text-xs text-muted" title={e.out_of_service_reason}>
                          {e.out_of_service_reason}
                          {e.expected_return_date ? ` · back ${formatDate(e.expected_return_date)}` : ""}
                        </div>
                      )}
                      {x.availability?.upcoming[0] && e.service_status === "in_service" && (
                        <div className="mt-1 text-xs text-muted">Shop {formatDate(x.availability.upcoming[0].date)}</div>
                      )}
                    </Td>
                    <Td className="hidden text-sm md:table-cell">
                      <div className="flex flex-col gap-1">
                        {x.maintenance && <span className={x.maintenance.tone === "red" ? "font-medium text-critical" : x.maintenance.tone === "amber" ? "text-amber-800" : "text-muted"}>{x.maintenance.text}</span>}
                        {x.documents && x.documents.expired > 0 && <span className="font-medium text-critical">{x.documents.expired} document{x.documents.expired === 1 ? "" : "s"} expired</span>}
                        {x.documents && x.documents.expiring > 0 && <span className="text-amber-800">{x.documents.expiring} expiring soon</span>}
                        {x.documents && x.documents.notRecorded.length > 0 && <span className="text-xs text-muted">No {x.documents.notRecorded.map((k) => k.toLowerCase()).join(" or ")} on file</span>}
                        {!x.maintenance && !(x.documents && (x.documents.expired || x.documents.expiring || x.documents.notRecorded.length)) && <span className="text-muted">—</span>}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}

export function EquipmentDetails({ e, timezone, who, extra = [] }: { e: Equipment; timezone: string; who: (id: string | null) => string; extra?: Array<{ label: string; value: React.ReactNode; wide?: boolean }> }) {
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody>
        <DescriptionList
          items={[
            { label: "Type", value: typeLabel(e) },
            { label: "Year / make / model", value: [e.model_year, e.make, e.model].filter(Boolean).join(" ") },
            { label: "VIN", value: e.vin },
            { label: "License plate", value: e.license_plate ? [e.plate_state, e.license_plate].filter(Boolean).join(" ") : "" },
            { label: "Ownership", value: "ownership" in e && e.ownership ? OWNERSHIP[e.ownership as Ownership] : <span className="text-muted">Not recorded</span> },
            ...extra,
            { label: "Added", value: `${formatDateTime(e.created_at, timezone)} by ${who(e.created_by)}` },
            { label: "Notes", value: e.notes, wide: true },
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function CapacityCard({ e, timezone, who }: { e: Equipment; timezone: string; who: (id: string | null) => string }) {
  return (
    <Card>
      <CardHeader title="Capacity" description="Recorded values only — unknown capacities are never estimated." />
      <CardBody>
        <DescriptionList
          items={[
            { label: "Capacity", value: <CapacityText e={e} /> },
            { label: "Source", value: e.capacity_source },
            {
              label: "Verified",
              value: e.capacity_verified_at ? `${formatDateTime(e.capacity_verified_at, timezone)} by ${who(e.capacity_verified_by)}` : "Not verified",
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function ServiceCard({ e, timezone }: { e: Equipment; timezone: string }) {
  return (
    <Card>
      <CardHeader title="Service status" />
      <CardBody>
        <DescriptionList
          items={[
            { label: "Status", value: <ServiceStatusBadge status={e.service_status} active={e.active} /> },
            { label: "Record", value: e.active ? "Active" : "Inactive (retired or sold)" },
            ...(e.service_status === "out_of_service"
              ? [
                  { label: "Reason", value: e.out_of_service_reason, wide: true },
                  { label: "Out since", value: formatDateTime(e.out_of_service_since, timezone) },
                  { label: "Expected back", value: e.expected_return_date ? formatDate(e.expected_return_date) : "Not set" },
                ]
              : []),
          ]}
        />
      </CardBody>
    </Card>
  );
}

const AUDIT_FIELD_LABELS: Record<string, string> = {
  unit_number: "Unit number",
  truck_type: "Type",
  trailer_type: "Type",
  make: "Make",
  model: "Model",
  model_year: "Year",
  vin: "VIN",
  license_plate: "Plate",
  plate_state: "Plate state",
  weight_capacity: "Weight capacity",
  weight_unit: "Weight unit",
  volume_capacity: "Volume",
  capacity_source: "Capacity source",
  capacity_verified_at: "Capacity verification",
  compatible_truck_types: "Compatible truck types",
  compatibility_notes: "Compatibility notes",
  default_truck_id: "Usual truck",
  active: "Active",
  notes: "Notes",
};

/** Status changes (everyone with fleet.view) and edits (audit log, people with audit.view). */
export function EquipmentHistory({ events, audit, timezone, who }: { events: EquipmentStatusEventRow[]; audit: AuditEventRow[]; timezone: string; who: (id: string | null) => string }) {
  const edits = audit
    .filter((a) => a.action.endsWith(".updated") || a.action.endsWith(".created"))
    .map((a) => ({
      id: a.id,
      at: a.occurred_at,
      actor: a.actor_id,
      title: a.action.endsWith(".created") ? "Added" : "Edited",
      detail: a.action.endsWith(".created")
        ? ""
        : Object.keys(a.details ?? {})
        .filter((k) => k in AUDIT_FIELD_LABELS)
        .map((k) => AUDIT_FIELD_LABELS[k])
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(", "),
    }))
    .filter((e) => e.title === "Added" || e.detail);
  const items = [
    ...events.map((e) => ({
      id: e.id,
      at: e.occurred_at,
      actor: e.actor_id,
      title: `${SERVICE_STATUS_LABELS[e.from_status]} → ${SERVICE_STATUS_LABELS[e.to_status]}`,
      detail: [e.reason, e.expected_return_date ? `expected back ${formatDate(e.expected_return_date)}` : ""].filter(Boolean).join(" · "),
      status: true,
    })),
    ...edits.map((e) => ({ ...e, status: false })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <Card className="self-start">
      <CardHeader title="History" description="Service status changes and edits, newest first." />
      {items.length === 0 ? (
        <CardBody>
          <p className="text-sm text-muted">No changes recorded yet.</p>
        </CardBody>
      ) : (
        <ol className="px-5 py-3 sm:px-6" aria-label="Equipment history">
          {items.map((e) => (
            <li key={e.id} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
              <span className={`absolute top-1 -left-[5px] size-2 rounded-full ${e.status ? "bg-strong" : "bg-line"}`} aria-hidden />
              <p className="text-sm font-semibold">{e.title}</p>
              {e.detail && <p className="text-sm">{e.detail}</p>}
              <p className="text-xs text-muted">
                {formatDateTime(e.at, timezone)} · {who(e.actor)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function CompatibilityText({ types }: { types: TrailerRow["compatible_truck_types"] }) {
  if (types.length === 0) return <Badge tone="amber">Not recorded</Badge>;
  const ordered = TRUCK_TYPES.filter((t) => types.includes(t));
  return <span>{ordered.map((t) => TRUCK_TYPE_LABELS[t]).join(", ")}</span>;
}

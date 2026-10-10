import Link from "next/link";
import { Plus, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { SERVICE_STATUS_LABELS, TRAILER_TYPE_LABELS, TRUCK_TYPE_LABELS, TRUCK_TYPES } from "@/lib/fleet/labels";
import type { AuditEventRow, EquipmentStatusEventRow, TrailerRow, TruckRow } from "@/server/data/types";
import { CapacityText, ServiceStatusBadge } from "./fleet-badges";

type Kind = "truck" | "trailer";
type Equipment = TruckRow | TrailerRow;

const typeLabel = (e: Equipment) => ("truck_type" in e ? TRUCK_TYPE_LABELS[e.truck_type] : TRAILER_TYPE_LABELS[(e as TrailerRow).trailer_type]);

export function EquipmentList({
  kind,
  rows,
  filters,
  typeOptions,
  canEdit,
}: {
  kind: Kind;
  rows: Equipment[];
  filters: { q?: string; status?: string; type?: string };
  typeOptions: Array<{ value: string; label: string }>;
  canEdit: boolean;
}) {
  const base = `/fleet/${kind}s`;
  const noun = kind === "truck" ? "truck" : "trailer";
  const filtered = Boolean(filters.q || filters.status || filters.type);
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
        <FilterSelect name="type" label="Type" value={filters.type} options={[{ value: "", label: "All types" }, ...typeOptions]} />
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
                <Th>Type</Th>
                <Th className="hidden md:table-cell">Make / model</Th>
                <Th className="hidden sm:table-cell">Capacity</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Tr key={e.id}>
                  <Td>
                    <Link href={`${base}/${e.id}`} className="font-semibold whitespace-nowrap tabular hover:text-brand hover:underline">
                      {e.unit_number}
                    </Link>
                    {e.license_plate && <div className="text-sm text-muted">{[e.plate_state, e.license_plate].filter(Boolean).join(" ")}</div>}
                  </Td>
                  <Td>{typeLabel(e)}</Td>
                  <Td className="hidden md:table-cell">{[e.model_year, e.make, e.model].filter(Boolean).join(" ") || <span className="text-muted">—</span>}</Td>
                  <Td className="hidden sm:table-cell"><CapacityText e={e} /></Td>
                  <Td>
                    <ServiceStatusBadge status={e.service_status} active={e.active} />
                    {e.active && e.service_status === "out_of_service" && (
                      <div className="mt-1 max-w-56 truncate text-xs text-muted" title={e.out_of_service_reason}>
                        {e.out_of_service_reason}
                        {e.expected_return_date ? ` · back ${formatDate(e.expected_return_date)}` : ""}
                      </div>
                    )}
                  </Td>
                </Tr>
              ))}
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
        <ol className="px-4 py-3 sm:px-5" aria-label="Equipment history">
          {items.map((e) => (
            <li key={e.id} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
              <span className={`absolute top-1 -left-[5px] size-2 rounded-full ${e.status ? "bg-charcoal" : "bg-line"}`} aria-hidden />
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

import { Plus } from "lucide-react";
import { EquipmentList } from "@/components/fleet/equipment-views";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { TRUCK_TYPE_LABELS, TRUCK_TYPES } from "@/lib/fleet/labels";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { buildDirectory, fleetContext, listTrucks } from "@/server/data/fleet";

import { baseOptions } from "@/server/data/bases";
export const metadata = { title: "Trucks" };

type Search = { q?: string; status?: string; type?: string; driver?: string; maintenance?: string; documents?: string; ownership?: string; sort?: string; base?: string };

export default async function TrucksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("fleet.view");
  const sp = await searchParams;
  // The base filter applies only where the company has bases to choose from (and the bases update is installed).
  const bases = await baseOptions();
  const [all, ctx] = await Promise.all([listTrucks({ ...sp, base: bases.length > 1 ? sp.base : undefined }), fleetContext({ maintenance: can(access, "maintenance.view") })]);
  const { rows, extras } = buildDirectory("truck", all, ctx, sp);
  const canEdit = can(access, "fleet.edit");
  return (
    <>
      <PageHeader
        title="Fleet"
        description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work."
        actions={canEdit && <ButtonLink href="/fleet/trucks/new" icon={<Plus className="size-4" />}>Add truck</ButtonLink>}
      />
      <FleetNav active="Trucks" />
      <EquipmentList kind="truck" rows={rows} filters={sp} canEdit={canEdit} bases={bases} extras={extras} sources={{ maintenance: ctx.maintenance.available, documents: ctx.documents.available }} typeOptions={TRUCK_TYPES.map((t) => ({ value: t, label: TRUCK_TYPE_LABELS[t] }))} />
    </>
  );
}

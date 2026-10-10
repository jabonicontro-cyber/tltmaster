import { Plus } from "lucide-react";
import { EquipmentList } from "@/components/fleet/equipment-views";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { TRUCK_TYPE_LABELS, TRUCK_TYPES } from "@/lib/fleet/labels";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listTrucks } from "@/server/data/fleet";

export const metadata = { title: "Trucks" };

type Search = { q?: string; status?: string; type?: string };

export default async function TrucksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("fleet.view");
  const sp = await searchParams;
  const rows = await listTrucks(sp);
  const canEdit = can(access, "fleet.edit");
  return (
    <>
      <PageHeader
        title="Fleet"
        description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work."
        actions={canEdit && <ButtonLink href="/fleet/trucks/new" icon={<Plus className="size-4" />}>Add truck</ButtonLink>}
      />
      <FleetNav active="Trucks" />
      <EquipmentList kind="truck" rows={rows} filters={sp} canEdit={canEdit} typeOptions={TRUCK_TYPES.map((t) => ({ value: t, label: TRUCK_TYPE_LABELS[t] }))} />
    </>
  );
}

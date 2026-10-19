import { Plus } from "lucide-react";
import { EquipmentList } from "@/components/fleet/equipment-views";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { TRAILER_TYPE_LABELS, TRAILER_TYPES } from "@/lib/fleet/labels";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { buildDirectory, fleetContext, listTrailers } from "@/server/data/fleet";

import { baseOptions } from "@/server/data/bases";
export const metadata = { title: "Trailers" };

type Search = { q?: string; status?: string; type?: string; driver?: string; maintenance?: string; documents?: string; ownership?: string; sort?: string; base?: string };

export default async function TrailersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("fleet.view");
  const sp = await searchParams;
  const [all, ctx, bases] = await Promise.all([listTrailers(sp), fleetContext({ maintenance: can(access, "maintenance.view") }), baseOptions()]);
  const { rows, extras } = buildDirectory("trailer", all, ctx, sp);
  const canEdit = can(access, "fleet.edit");
  return (
    <>
      <PageHeader
        title="Fleet"
        description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work."
        actions={canEdit && <ButtonLink href="/fleet/trailers/new" icon={<Plus className="size-4" />}>Add trailer</ButtonLink>}
      />
      <FleetNav active="Trailers" />
      <EquipmentList kind="trailer" rows={rows} filters={sp} canEdit={canEdit} bases={bases} extras={extras} sources={{ maintenance: ctx.maintenance.available, documents: ctx.documents.available }} typeOptions={TRAILER_TYPES.map((t) => ({ value: t, label: TRAILER_TYPE_LABELS[t] }))} />
    </>
  );
}

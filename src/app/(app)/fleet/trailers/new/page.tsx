import { EquipmentForm } from "@/components/fleet/equipment-form";
import { EMPTY_EQUIPMENT } from "@/components/fleet/form-defaults";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { uuid } from "@/lib/schemas/common";
import { requirePagePermission } from "@/server/auth";
import { truckOptions } from "@/server/data/fleet";
import { saveTrailer } from "../../actions";

export const metadata = { title: "Add trailer" };

export default async function NewTrailerPage({ searchParams }: { searchParams: Promise<{ truck?: string }> }) {
  await requirePagePermission("fleet.edit");
  const { truck } = await searchParams;
  const trucks = await truckOptions();
  const preset = truck && uuid.safeParse(truck).success && trucks.some((t) => t.id === truck) ? truck : null;
  return (
    <>
      <PageHeader title="Add trailer" crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Trailers", href: "/fleet/trailers" }, { label: "Add" }]} />
      <Card>
        <CardBody>
          <EquipmentForm
            kind="trailer"
            initial={{ ...EMPTY_EQUIPMENT, default_truck_id: preset }}
            trucks={trucks}
            action={saveTrailer.bind(null, null)}
            cancelHref="/fleet/trailers"
            submitLabel="Add trailer"
          />
        </CardBody>
      </Card>
    </>
  );
}

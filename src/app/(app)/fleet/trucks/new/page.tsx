import { EquipmentForm } from "@/components/fleet/equipment-form";
import { EMPTY_EQUIPMENT } from "@/components/fleet/form-defaults";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { saveTruck } from "../../actions";

import { baseOptions } from "@/server/data/bases";
import { truckDimensionsInstalled } from "@/server/data/route-planner";
export const metadata = { title: "Add truck" };

const NO_DIMENSIONS = { height_cm: null, width_cm: null, length_cm: null, gross_weight_kg: null, axle_count: null };

export default async function NewTruckPage() {
  await requirePagePermission("fleet.edit");
  return (
    <>
      <PageHeader title="Add truck" crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Trucks", href: "/fleet/trucks" }, { label: "Add" }]} />
      <Card>
        <CardBody>
          <EquipmentForm kind="truck" initial={EMPTY_EQUIPMENT} action={saveTruck.bind(null, null)} cancelHref="/fleet/trucks" submitLabel="Add truck" bases={await baseOptions()} dimensions={(await truckDimensionsInstalled()) ? NO_DIMENSIONS : undefined} />
        </CardBody>
      </Card>
    </>
  );
}

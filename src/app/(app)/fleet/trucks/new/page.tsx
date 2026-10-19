import { EquipmentForm } from "@/components/fleet/equipment-form";
import { EMPTY_EQUIPMENT } from "@/components/fleet/form-defaults";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { saveTruck } from "../../actions";

import { baseOptions } from "@/server/data/bases";
export const metadata = { title: "Add truck" };

export default async function NewTruckPage() {
  await requirePagePermission("fleet.edit");
  return (
    <>
      <PageHeader title="Add truck" crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Trucks", href: "/fleet/trucks" }, { label: "Add" }]} />
      <Card>
        <CardBody>
          <EquipmentForm kind="truck" initial={EMPTY_EQUIPMENT} action={saveTruck.bind(null, null)} cancelHref="/fleet/trucks" submitLabel="Add truck" bases={await baseOptions()} />
        </CardBody>
      </Card>
    </>
  );
}

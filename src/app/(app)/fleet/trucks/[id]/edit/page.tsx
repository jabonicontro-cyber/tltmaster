import { notFound } from "next/navigation";
import { EquipmentForm } from "@/components/fleet/equipment-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { getTruck } from "@/server/data/fleet";
import { saveTruck } from "../../../actions";

import { baseOptions, recordBase } from "@/server/data/bases";
export const metadata = { title: "Edit truck" };

export default async function EditTruckPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("fleet.edit");
  const { id } = await params;
  const detail = await getTruck(id);
  if (!detail) notFound();
  const t = detail.truck;
  return (
    <>
      <PageHeader
        title={`Edit truck ${t.unit_number}`}
        crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Trucks", href: "/fleet/trucks" }, { label: t.unit_number, href: `/fleet/trucks/${id}` }, { label: "Edit" }]}
      />
      <Card>
        <CardBody>
          <EquipmentForm
            kind="truck"
            initial={{ ...t, type: t.truck_type, capacity_verified: Boolean(t.capacity_verified_at) }}
            action={saveTruck.bind(null, id)}
            cancelHref={`/fleet/trucks/${id}`}
            submitLabel="Save truck"
            bases={await baseOptions()}
            baseId={await recordBase("trucks", id)}
          />
        </CardBody>
      </Card>
    </>
  );
}

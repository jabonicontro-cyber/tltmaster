import { notFound } from "next/navigation";
import { EquipmentForm } from "@/components/fleet/equipment-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { getTrailer, truckOptions } from "@/server/data/fleet";
import { saveTrailer } from "../../../actions";

export const metadata = { title: "Edit trailer" };

export default async function EditTrailerPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("fleet.edit");
  const { id } = await params;
  const [detail, trucks] = await Promise.all([getTrailer(id), truckOptions()]);
  if (!detail) notFound();
  const t = detail.trailer;
  return (
    <>
      <PageHeader
        title={`Edit trailer ${t.unit_number}`}
        crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Trailers", href: "/fleet/trailers" }, { label: t.unit_number, href: `/fleet/trailers/${id}` }, { label: "Edit" }]}
      />
      <Card>
        <CardBody>
          <EquipmentForm
            kind="trailer"
            initial={{ ...t, type: t.trailer_type, capacity_verified: Boolean(t.capacity_verified_at) }}
            trucks={trucks}
            action={saveTrailer.bind(null, id)}
            cancelHref={`/fleet/trailers/${id}`}
            submitLabel="Save trailer"
          />
        </CardBody>
      </Card>
    </>
  );
}

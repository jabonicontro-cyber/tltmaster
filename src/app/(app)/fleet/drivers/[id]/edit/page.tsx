import { notFound } from "next/navigation";
import { DriverForm } from "@/components/fleet/driver-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { getDriver, linkableUsers } from "@/server/data/fleet";
import { saveDriver } from "../../../actions";

export const metadata = { title: "Edit driver" };

export default async function EditDriverPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("fleet.edit");
  const { id } = await params;
  const detail = await getDriver(id);
  if (!detail) notFound();
  const d = detail.driver;
  const users = await linkableUsers(d.user_id);
  return (
    <>
      <PageHeader
        title={`Edit ${d.display_name}`}
        crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Drivers", href: "/fleet/drivers" }, { label: d.display_name, href: `/fleet/drivers/${id}` }, { label: "Edit" }]}
      />
      <Card>
        <CardBody>
          <DriverForm initial={d} users={users} action={saveDriver.bind(null, id)} cancelHref={`/fleet/drivers/${id}`} submitLabel="Save driver" />
        </CardBody>
      </Card>
    </>
  );
}

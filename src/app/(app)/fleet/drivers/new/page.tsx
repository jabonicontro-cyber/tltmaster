import { DriverForm } from "@/components/fleet/driver-form";
import { EMPTY_DRIVER } from "@/components/fleet/form-defaults";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { linkableUsers } from "@/server/data/fleet";
import { saveDriver } from "../../actions";

export const metadata = { title: "Add driver" };

export default async function NewDriverPage() {
  await requirePagePermission("fleet.edit");
  const users = await linkableUsers();
  return (
    <>
      <PageHeader
        title="Add driver"
        crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Drivers", href: "/fleet/drivers" }, { label: "Add" }]}
        description="Licenses and medical cards are added on the driver's page after saving."
      />
      <Card>
        <CardBody>
          <DriverForm initial={EMPTY_DRIVER} users={users} action={saveDriver.bind(null, null)} cancelHref="/fleet/drivers" submitLabel="Add driver" />
        </CardBody>
      </Card>
    </>
  );
}

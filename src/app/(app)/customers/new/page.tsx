import { CustomerForm, EMPTY_CUSTOMER } from "@/components/customers/customer-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { listPriceLists } from "@/server/data/catalog";
import { createCustomer } from "../actions";

export const metadata = { title: "New customer" };

export default async function NewCustomerPage() {
  await requirePagePermission("customers.edit");
  const priceLists = (await listPriceLists()).filter((p) => !p.is_standard);
  return (
    <>
      <PageHeader title="New customer" crumbs={[{ label: "Customers", href: "/customers" }, { label: "New" }]} />
      <Card>
        <CardBody>
          <CustomerForm initial={EMPTY_CUSTOMER} priceLists={priceLists} action={createCustomer} submitLabel="Create customer" cancelHref="/customers" withContact />
        </CardBody>
      </Card>
    </>
  );
}

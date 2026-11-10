import { notFound } from "next/navigation";
import { CustomerForm } from "@/components/customers/customer-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listPriceLists } from "@/server/data/catalog";
import { getCustomer } from "@/server/data/customers";
import { updateCustomer } from "../../actions";

export const metadata = { title: "Edit customer" };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("customers.edit");
  const { id } = await params;
  const [customer, lists] = await Promise.all([getCustomer(id), listPriceLists({ includeInactive: true })]);
  if (!customer) notFound();
  const priceLists = lists.filter((p) => !p.is_standard);
  const action = updateCustomer.bind(null, id);
  return (
    <>
      <PageHeader
        title={`Edit ${customer.name}`}
        crumbs={[{ label: "Customers", href: "/customers" }, { label: customer.name, href: `/customers/${id}` }, { label: "Edit" }]}
      />
      <Card>
        <CardBody>
          <CustomerForm initial={customer} priceLists={priceLists} action={action} money={{ pricing: can(access, "pricing.edit"), billing: can(access, "billing.manage") }} submitLabel="Save changes" cancelHref={`/customers/${id}`} />
        </CardBody>
      </Card>
    </>
  );
}

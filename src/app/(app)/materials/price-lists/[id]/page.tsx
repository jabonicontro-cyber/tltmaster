import Link from "next/link";
import { notFound } from "next/navigation";
import { PriceEntriesTable } from "@/components/catalog/price-list-client";
import { Badge, SampleBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getPriceList, listChargeItems, listMaterials, listUnits } from "@/server/data/catalog";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Price list" };

export default async function PriceListPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("materials.view");
  const { id } = await params;
  const [detail, materials, charges, units, { today }] = await Promise.all([
    getPriceList(id),
    listMaterials({ includeInactive: true }),
    listChargeItems({ includeInactive: true }),
    listUnits(),
    businessToday(),
  ]);
  if (!detail) notFound();
  const { list, entries, customers } = detail;

  return (
    <>
      <PageHeader
        title={list.name}
        crumbs={[{ label: "Materials & Pricing", href: "/materials?tab=prices" }, { label: list.name }]}
        description={list.description}
        badges={
          <>
            {list.is_standard && <Badge tone="brand">Standard</Badge>}
            {!list.active && <Badge>Inactive</Badge>}
            <SampleBadge show={list.is_sample} />
          </>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
        <Card className="lg:col-span-3">
          <PriceEntriesTable
            priceListId={list.id}
            entries={entries}
            materials={materials}
            charges={charges}
            units={units}
            today={today}
            canEdit={can(access, "pricing.edit")}
          />
        </Card>
        <Card>
          <CardHeader title="Used by" />
          <CardBody>
            {list.is_standard ? (
              <p className="text-sm text-muted">All customers, whenever their own price list has no rate for an item.</p>
            ) : customers.length === 0 ? (
              <p className="text-sm text-muted">No customers use this list yet. Choose it on a customer&apos;s edit page.</p>
            ) : (
              <ul className="space-y-1 text-[15px]">
                {customers.map((c) => (
                  <li key={c.id}>
                    <Link href={`/customers/${c.id}`} className="hover:underline">{c.name}</Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

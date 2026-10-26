import Link from "next/link";
import { ChargesTable, MaterialsTable, PriceListsTable, UnitsTable } from "@/components/catalog/catalog-client";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listChargeItems, listMaterials, listPriceLists, listUnits } from "@/server/data/catalog";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Materials & Pricing" };

const TABS = [
  { key: "materials", label: "Materials" },
  { key: "charges", label: "Hauling & charges" },
  { key: "prices", label: "Price lists" },
  { key: "units", label: "Units" },
] as const;

export default async function MaterialsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const access = await requirePagePermission("materials.view");
  const { tab: rawTab } = await searchParams;
  const tab = TABS.some((t) => t.key === rawTab) ? rawTab! : "materials";
  const canEdit = can(access, "materials.edit");

  let content: React.ReactNode;
  if (tab === "materials") {
    const [rows, units] = await Promise.all([listMaterials({ includeInactive: true }), listUnits()]);
    content = <MaterialsTable rows={rows} units={units} canEdit={canEdit} />;
  } else if (tab === "charges") {
    const [rows, units] = await Promise.all([listChargeItems({ includeInactive: true }), listUnits()]);
    content = <ChargesTable rows={rows} units={units} canEdit={canEdit} />;
  } else if (tab === "units") {
    content = <UnitsTable rows={await listUnits(true)} canEdit={canEdit} />;
  } else {
    const rows = await listPriceLists({ includeInactive: true });
    const supabase = await createClient();
    const { data: links } = await supabase.from("customers").select("price_list_id").not("price_list_id", "is", null);
    const usage: Record<string, number> = {};
    for (const l of links ?? []) usage[l.price_list_id as string] = (usage[l.price_list_id as string] ?? 0) + 1;
    content = <PriceListsTable rows={rows} usage={usage} canEdit={can(access, "pricing.edit")} />;
  }

  return (
    <>
      <PageHeader title="Materials & Pricing" description="Catalog and rates used to build quotes. Changing a rate never changes a saved quote." />
      <nav aria-label="Catalog sections" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/materials?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-150",
              tab === t.key ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
            )}
          >
            <span className="pill-text">{t.label}</span>
          </Link>
        ))}
      </nav>
      <Card>{content}</Card>
    </>
  );
}

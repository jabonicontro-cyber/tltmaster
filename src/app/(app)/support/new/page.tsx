import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewCaseForm } from "@/components/support/case-forms";
import { uuid } from "@/lib/schemas/common";
import { requirePagePermission } from "@/server/auth";
import { getUserNames } from "@/server/data/quotes";
import { supportLinkOptions } from "@/server/data/support";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "New Support Case" };

export default async function NewSupportCase({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const access = await requirePagePermission("customers.edit");
  const { customer } = await searchParams;
  const chosen = customer && uuid.safeParse(customer).success ? customer : "";
  const [{ data: customers }, names, links] = await Promise.all([
    (await createClient()).from("customers").select("id, name").order("name").limit(1000),
    getUserNames(),
    chosen ? supportLinkOptions(chosen) : Promise.resolve({ orders: [], tickets: [], invoices: [] }),
  ]);
  return (
    <>
      <p className="mb-2 text-sm"><Link href="/support" className="text-muted hover:text-ink hover:underline">← Support</Link></p>
      <PageHeader title="New support case" description="For a call, an email or a visit: the customer sees the case in their portal and gets an email notice." />
      <Card>
        <CardHeader title="Case" />
        <CardBody>
          <NewCaseForm customers={((customers ?? []) as Array<{ id: string; name: string }>).map((c) => ({ id: c.id, label: c.name }))} customer={chosen}
            staff={Object.entries(names).map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))} me={access.userId} links={links} />
        </CardBody>
      </Card>
    </>
  );
}

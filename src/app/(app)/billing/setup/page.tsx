import { AddBusinessButton, EditBusinessButton, QuickBooksPanel, SplitRules } from "@/components/billing/accounting-setup";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { can } from "@/lib/permissions";
import { listItems, qboConfigured } from "@/server/accounting/qbo";
import { requirePagePermission } from "@/server/auth";
import { getAccountingSetup, type AccountingConnection } from "@/server/data/accounting";

export const metadata = { title: "Businesses and QuickBooks" };

/**
 * Billing businesses (cost centers) and QuickBooks Online (master plan B82, B89): which business bills each charge
 * type, each business's details, and its own QuickBooks company. Sending happens on the Billing board after handoff.
 */
export default async function BillingSetupPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const access = await requirePagePermission("billing.view");
  const manage = can(access, "billing.manage");
  const sp = await searchParams;
  const setup = await getAccountingSetup();
  const configured = qboConfigured();

  // The product/service list of each connected QuickBooks company (read live; a failure is shown, not hidden).
  const itemsFor = async (c: AccountingConnection | null) => {
    if (!c || c.status !== "connected" || access.isDemo) return { items: null, error: null };
    try {
      return { items: await listItems({ connectionId: c.id, realmId: c.realm_id, environment: c.environment }), error: null };
    } catch (e) {
      return { items: null, error: e instanceof Error ? e.message : "QuickBooks could not be reached." };
    }
  };
  const byEntity = (id: string | null) => setup.connections.find((c) => c.billing_entity_id === id) ?? null;
  const company = byEntity(null);
  const panels = await Promise.all([null, ...setup.entities.map((e) => e.id)].map(async (id) => [id ?? "", await itemsFor(byEntity(id))] as const));
  const items = Object.fromEntries(panels);

  return (
    <>
      <PageHeader title="Businesses and QuickBooks" crumbs={[{ label: "Billing", href: "/billing" }, { label: "Businesses and QuickBooks" }]}
        description="When one company bills from more than one business (for example materials from a sand and gravel company, delivery from a trucking company), each business sends its own invoices from its own QuickBooks. Orders, dispatch and tickets stay as one."
        actions={manage && setup.entitiesInstalled ? <AddBusinessButton /> : undefined} />
      {sp.saved === "connected" && <div className="mb-4"><Notice title="QuickBooks connected">Choose the product or service for invoice lines below, then send handed-off orders from the Billing board.</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="warning" title="QuickBooks">{sp.error}</Notice></div>}
      {!setup.entitiesInstalled || !setup.quickbooksInstalled ? (
        <Notice title="Not available yet">Businesses and QuickBooks need a database update that has not been installed yet.</Notice>
      ) : (
        <div className="space-y-5">
          {setup.entities.length === 0 ? (
            <Card>
              <CardHeader title="One business" description="Everything is billed under the company. Add a business when part of the work is billed by another business you own." />
              <CardBody><QuickBooksPanel entityId={null} connection={company} items={items[""]?.items ?? null} itemsError={items[""]?.error ?? null} canManage={manage} configured={configured} isDemo={Boolean(access.isDemo)} /></CardBody>
            </Card>
          ) : (
            <>
              <SplitRules entities={setup.entities} rules={setup.rules} canManage={manage} />
              {setup.entities.map((e) => (
                <Card key={e.id}>
                  <CardHeader title={<span className="flex flex-wrap items-center gap-2">{e.name}{e.is_default && <Badge tone="blue">Default</Badge>}{!e.active && <Badge tone="gray">Inactive</Badge>}</span>}
                    description={[e.legal_name, [e.address_line1, e.city, e.region, e.postal_code].filter(Boolean).join(", "), e.invoice_prefix ? `Invoice prefix ${e.invoice_prefix}` : ""].filter(Boolean).join(" · ") || "No address yet"}
                    actions={manage ? <EditBusinessButton entity={e} /> : undefined} />
                  <CardBody>
                    <h3 className="mb-2 text-sm font-semibold text-ink">QuickBooks</h3>
                    <QuickBooksPanel entityId={e.id} connection={byEntity(e.id)} items={items[e.id]?.items ?? null} itemsError={items[e.id]?.error ?? null} canManage={manage} configured={configured} isDemo={Boolean(access.isDemo)} />
                  </CardBody>
                </Card>
              ))}
            </>
          )}
          <p className="text-sm text-muted">Nothing is sent to QuickBooks until a person presses Send on a handed-off order. Payments and payroll are not sent.</p>
        </div>
      )}
    </>
  );
}

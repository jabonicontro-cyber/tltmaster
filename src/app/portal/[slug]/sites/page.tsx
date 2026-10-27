import { notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SiteInfoForm } from "@/components/portal/site-info-form";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Job Sites" };

type Site = { id: string; label: string; address: string; pending: number };

/** The customer's job sites (B94): tell the hauler the gate code, drop spot and contact once, with photos. */
export default async function PortalSites({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/sites`);
  if (!c.features.orders) notFound();
  const sites = await portalCall<Site[]>("portal_sites", { p_slug: slug });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Job Sites</h1>
        <p className="text-sm text-muted">Tell {c.name} how to get in and where to drop. Their office checks it before drivers see it.</p>
      </div>
      {sites.length === 0 ? (
        <Card><CardBody><p className="text-sm text-muted">No job sites yet. They appear here once {c.name} has one on file for you.</p></CardBody></Card>
      ) : (
        sites.map((s) => (
          <Card key={s.id}>
            <CardHeader title={s.label} description={[s.address, s.pending ? `${s.pending} note${s.pending === 1 ? "" : "s"} waiting for the office` : ""].filter(Boolean).join(" · ")} />
            <CardBody><SiteInfoForm slug={slug} siteId={s.id} siteLabel={s.label} /></CardBody>
          </Card>
        ))
      )}
    </div>
  );
}

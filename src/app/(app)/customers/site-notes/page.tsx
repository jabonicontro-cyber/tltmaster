import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { SiteNoteReview } from "@/components/customers/site-note-review";
import { formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { pendingSiteNotes, proposedDirections } from "@/server/data/site-notes";

export const metadata = { title: "Site notes from customers" };

/** Job-site notes customers sent from their portal (B94), waiting for the office before drivers see anything. */
export default async function SiteNotesPage() {
  const access = await requirePagePermission("customers.view");
  const [notes, { timezone }] = await Promise.all([pendingSiteNotes(), businessToday()]);
  const canEdit = can(access, "customers.edit");
  return (
    <>
      <PageHeader
        title="Site notes from customers"
        crumbs={[{ label: "Customers", href: "/customers" }, { label: "Site notes" }]}
        description="Gate codes, drop spots, site contacts and photos customers sent from their portal. Nothing reaches drivers until it is applied here."
      />
      {notes === null ? (
        <Notice title="Needs a database update">Site notes from customers need a database update that has not been installed yet.</Notice>
      ) : notes.length === 0 ? (
        <Card><EmptyState title="No notes waiting" description="When a customer sends details about a job site from their portal, it appears here for review." /></Card>
      ) : (
        <div className="space-y-4">
          {notes.map((n) => (
            <Card key={n.id}>
              <CardHeader title={`${n.site} · ${n.customer}`} description={`Sent ${formatDateTime(n.submitted_at, timezone)}`} />
              <CardBody className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-3 text-sm">
                  <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                    {[["Gate code", n.gate_code], ["Where to drop", n.drop_spot], ["Contact", [n.contact_name, n.contact_phone].filter(Boolean).join(", ")], ["Notes", n.notes]]
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="whitespace-pre-wrap">{v}</dd></div>
                      ))}
                  </dl>
                  {n.photos.length ? (
                    <ul className="grid grid-cols-3 gap-2" aria-label="Photos">
                      {n.photos.map((p, i) => (
                        <li key={p}>
                          <a href={`/site-photos/${p}`} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg border border-line">
                            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed link */}
                            <img src={`/site-photos/${p}`} alt={`Site photo ${i + 1}`} className="aspect-[4/3] w-full object-cover" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {canEdit ? <SiteNoteReview id={n.id} proposed={proposedDirections(n)} /> : <p className="text-sm text-muted">Someone with permission to edit customers reviews these.</p>}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { formatDateTime } from "@/lib/dates";
import { requireAccess } from "@/server/auth";
import { mySupportRequests } from "@/server/help";
import { SupportForm } from "@/components/help/support-form";

export const metadata = { title: "Contact Support" };

/**
 * Contact Taviron support from Help. The person writes the message, sees exactly what will be sent (including the page
 * they came from, only if they keep it), then sends it. Nothing else is attached. It is stored for the Taviron team;
 * no email is sent from here.
 */
export default async function ContactSupportPage({ searchParams }: { searchParams: Promise<{ from?: string; article?: string; sent?: string; error?: string }> }) {
  await requireAccess();
  const sp = await searchParams;
  const from = (sp.from ?? "").startsWith("/") ? (sp.from ?? "").slice(0, 200) : "";
  const mine = await mySupportRequests();
  return (
    <div className="max-w-3xl">
      <PageHeader title="Contact Support" description="Write to the Taviron team when Help did not answer your question." crumbs={[{ label: "Help Center", href: "/help" }, { label: "Contact Support" }]} />
      {sp.sent ? <div className="mb-4"><Notice title="Sent to Taviron support">Your request is saved for the Taviron team. They reply by email or phone using the contact details on your account.</Notice></div> : null}
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Not sent">{sp.error}</Notice></div> : null}
      <Card>
        <CardBody>
          <SupportForm from={from} article={sp.article && /^[a-z0-9-]{1,80}$/.test(sp.article) ? sp.article : undefined} />
        </CardBody>
      </Card>
      {mine && mine.length ? (
        <section aria-labelledby="my-requests" className="mt-6">
          <h2 id="my-requests" className="mb-2 text-base font-semibold">Your Recent Requests</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-card text-sm">
            {mine.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <span className="text-muted">{formatDateTime(r.created_at)} · {r.status === "new" ? "Waiting for Taviron" : r.status === "answered" ? "Answered" : "Closed"}</span>
                <p className="mt-1 line-clamp-2">{r.message}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

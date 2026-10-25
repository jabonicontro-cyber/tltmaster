import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ContactCard } from "@/components/portal/contact-card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PortalUnavailable } from "@/components/portal/portal-unavailable";
import { formatDay, QUOTE_STATUS_LABEL, scheduleText, SUPPORT_STATUS_LABEL, type PortalCompany, type PortalOrderSummary, type PortalQuoteRow, type PortalSupportRow } from "@/lib/portal";
import { portalCall, portalGate } from "@/server/portal";

export default async function PortalHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await portalGate(slug);

  if (gate.kind !== "customer") {
    const company = gate.company;
    if (!company) {
      return <PortalUnavailable />;
    }
    return <PublicPage slug={slug} company={company} noAccess={gate.kind === "no-access"} />;
  }

  const c = gate.context;
  const [orders, quotes, support] = await Promise.all([
    c.features.orders ? portalCall<PortalOrderSummary[]>("portal_orders", { p_slug: slug }) : Promise.resolve([]),
    c.features.quotes ? portalCall<{ quotes: PortalQuoteRow[] }>("portal_quotes", { p_slug: slug }) : Promise.resolve({ quotes: [] }),
    c.features.support ? portalCall<PortalSupportRow[]>("portal_support_list", { p_slug: slug }) : Promise.resolve([]),
  ]);
  const active = orders.filter((o) => !["completed", "canceled"].includes(o.status));
  const awaiting = quotes.quotes.filter((q) => q.status === "sent" && !q.response);
  const answered = support.filter((s) => s.status === "answered");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Welcome, {c.customer.name}</h1>
        {c.welcome ? <p className="mt-2 max-w-2xl whitespace-pre-line text-[15px] text-muted">{c.welcome}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {c.features.orders ? <Stat label="Open orders" value={active.length} href={`/portal/${slug}/orders`} /> : null}
        {c.features.quotes ? <Stat label="Quotes awaiting your answer" value={awaiting.length} href={`/portal/${slug}/quotes`} /> : null}
        {c.features.support ? <Stat label="New replies from us" value={answered.length} href={`/portal/${slug}/support`} /> : null}
      </div>

      {c.features.orders ? (
        <Card>
          <CardHeader title="Upcoming and Open Orders" actions={<Link href={`/portal/${slug}/orders`} className="text-sm font-semibold text-brand-fg hover:underline">All orders</Link>} />
          <CardBody>
            {active.length ? (
              <ul className="divide-y divide-line">
                {active.slice(0, 5).map((o) => (
                  <li key={o.id}>
                    <Link href={`/portal/${slug}/orders/${o.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
                      <span>
                        <span className="block font-semibold text-ink">Order {o.number}{o.materials ? ` · ${o.materials}` : ""}</span>
                        <span className="block text-sm text-muted">{scheduleText(o) ?? "Not scheduled yet"}{o.site ? ` · ${o.site}` : ""}</span>
                      </span>
                      <Badge tone="brand">{o.status_label}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No open orders right now.</p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {awaiting.length ? (
        <Card>
          <CardHeader title="Quotes Awaiting Your Answer" />
          <CardBody>
            <ul className="divide-y divide-line">
              {awaiting.map((q) => (
                <li key={q.id}>
                  <Link href={`/portal/${slug}/quotes/${q.id}`} className="flex items-center justify-between gap-2 py-3 hover:bg-surface">
                    <span className="font-semibold text-ink">Quote {q.number}{q.project ? ` · ${q.project}` : ""}</span>
                    <span className="text-sm text-muted">{q.valid_until ? `Valid until ${formatDay(q.valid_until)}` : QUOTE_STATUS_LABEL[q.status]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {answered.length ? (
        <p className="text-sm text-muted">
          {answered.length} support {answered.length === 1 ? "request has" : "requests have"} a reply ({SUPPORT_STATUS_LABEL.answered.toLowerCase()}).{" "}
          <Link href={`/portal/${slug}/support`} className="font-semibold text-brand-fg hover:underline">Read</Link>
        </p>
      ) : null}

      <ContactCard company={c} />
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="rounded-panel border border-line/70 bg-card shadow-card p-4 hover:border-strong focus-visible:outline-2 focus-visible:outline-strong">
      <span className="block text-sm text-muted">{label}</span>
      <span className="tabular mt-1 block text-2xl font-bold text-ink">{value}</span>
    </Link>
  );
}

function PublicPage({ slug, company, noAccess }: { slug: string; company: PortalCompany & { public_page: boolean }; noAccess: boolean }) {
  return (
    <div className="space-y-6">
      <div className="rounded-panel border border-line/70 bg-card shadow-card p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-ink">{company.name} Customer Portal</h1>
        {company.public_page && company.welcome ? <p className="mt-3 max-w-2xl whitespace-pre-line text-[15px] text-muted">{company.welcome}</p> : null}
        <p className="mt-3 max-w-2xl text-[15px] text-muted">Customers can sign in to follow their orders and deliveries, see quotes, and ask us questions.</p>
        {noAccess ? (
          <p className="mt-4 text-sm text-muted">You are signed in, but this account has no access to this portal. Ask {company.name} for an invitation, or sign out and use the invited email.</p>
        ) : (
          <Link href={`/portal/${slug}/login`} className={buttonClasses("primary", "lg", "mt-5 inline-flex")}>
            Sign In <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
      {company.public_page && company.features.help ? (
        <p className="text-sm">
          <Link href={`/portal/${slug}/help`} className="font-semibold text-brand-fg hover:underline">Questions? Read our help articles</Link>
        </p>
      ) : null}
      {company.public_page ? <ContactCard company={company} /> : null}
    </div>
  );
}

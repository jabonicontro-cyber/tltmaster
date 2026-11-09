import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";
import { ContactCard } from "@/components/portal/contact-card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PortalUnavailable } from "@/components/portal/portal-unavailable";
import { formatDay, formatMoney, formatWindow, QUOTE_STATUS_LABEL, scheduleText, SUPPORT_STATUS_LABEL, type PortalCompany, type PortalInvoices, type PortalOrder, type PortalOrderSummary, type PortalQuoteRow, type PortalSupportRow, portalIsPast } from "@/lib/portal";
import { trimNumber } from "@/lib/fleet/labels";
import { portalCall, portalGate } from "@/server/portal";
import { previewPortalAs } from "@/app/admin/testing-lab/actions";
import { Field, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { isPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

export default async function PortalHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await portalGate(slug);

  if (gate.kind !== "customer") {
    const company = gate.company;
    if (!company) {
      return <PortalUnavailable />;
    }
    return <PublicPage slug={slug} company={company} noAccess={gate.kind === "no-access"} demoPreview={gate.kind === "no-access" ? await demoPreviewOptions(slug) : null} />;
  }

  const c = gate.context;
  const [orders, quotes, support] = await Promise.all([
    c.features.orders ? portalCall<PortalOrderSummary[]>("portal_orders", { p_slug: slug }) : Promise.resolve([]),
    c.features.quotes ? portalCall<{ quotes: PortalQuoteRow[] }>("portal_quotes", { p_slug: slug }) : Promise.resolve({ quotes: [] }),
    c.features.support ? portalCall<PortalSupportRow[]>("portal_support_list", { p_slug: slug }) : Promise.resolve([]),
  ]);
  // The company's today (its time zone), not the server's.
  const dayIn = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: c.timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = dayIn(new Date());
  const active = orders.filter((o) => !portalIsPast(o, today));
  // Today (UX5): for orders scheduled today, the loads planned for today and the tickets delivered so far, from recorded
  // data only (no estimates). At most five orders.
  const todays = active.filter((o) => o.scheduled_start && o.scheduled_start <= today && (o.scheduled_end ?? o.scheduled_start) >= today).slice(0, 5);
  // Read directly (not portalCall, which turns any refusal into "not found" for the whole page): a failed order is left out.
  const sb = await createClient();
  const todayDetail = (await Promise.all(todays.map(async (o) => { const r = await sb.rpc("portal_order", { p_slug: slug, p_order: o.id }); return r.error ? null : (r.data as PortalOrder); })))
    .filter((d): d is PortalOrder => d !== null)
    .map((d) => {
      const loads = d.loads.filter((l) => l.date === today && !l.canceled);
      const delivered = d.tickets.filter((t) => dayIn(new Date(t.delivered_at)) === today);
      const units = [...new Set(delivered.map((t) => t.unit))];
      const qty = units.length === 1 ? `${trimNumber(String(delivered.reduce((n, t) => n + Number(t.quantity), 0)))} ${units[0].replace(/_/g, " ")}` : "";
      // The next planned load (portal_orders: the earliest load still planned), when it is today and has a time.
      const next = todays.find((o) => o.id === d.id)?.next_load;
      const nextWindow = next && next.date === today ? formatWindow(next.start, next.end) : "";
      return { id: d.id, number: d.number, site: d.site, planned: loads.length, delivered: delivered.length, qty, nextWindow };
    })
    .filter((d) => d.planned > 0 || d.delivered > 0);
  // Account balance (UX5 statement): only when the portal already shows invoices; a failed read leaves the card out.
  const statement = c.features.invoices ? await sb.rpc("portal_invoices", { p_slug: slug }).then((r) => {
    const d = r.error ? null : (r.data as PortalInvoices | null);
    return d && d.enabled ? { ...d.statement, as_of: d.as_of } : null;
  }) : null;
  const awaiting = quotes.quotes.filter((q) => q.status === "sent" && !q.response);
  const answered = support.filter((s) => s.status === "answered");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] text-ink">Welcome, {c.customer.name}</h1>
        {c.welcome ? <p className="mt-2 max-w-2xl whitespace-pre-line text-[15px] text-muted">{c.welcome}</p> : null}
      </div>

      {statement ? (
        <Link href={`/portal/${slug}/invoices`} data-testid="portal-balance" className="block rounded-panel border border-line/70 bg-card p-4 shadow-card hover:border-strong focus-visible:outline-2 focus-visible:outline-strong sm:p-5">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-muted">Account balance</span>
            <span className="text-xs text-muted">As of {formatDay(statement.as_of)}</span>
          </span>
          <span className="tabular mt-1 block text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] text-ink">{formatMoney(statement.balance_cents)}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted">{statement.open_count ? `${statement.open_count} open invoice${statement.open_count === 1 ? "" : "s"}` : "No open invoices"}</span>
            {statement.overdue_cents > 0 ? <span className="font-semibold text-amber-700">{formatMoney(statement.overdue_cents)} past due</span> : <span className="text-muted">Nothing past due</span>}
            <span className="ml-auto inline-flex items-center gap-0.5 font-semibold text-brand-fg">See invoices<ChevronRight className="size-4" aria-hidden /></span>
          </span>
        </Link>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {c.features.orders ? <Stat label="Open orders" value={active.length} href={`/portal/${slug}/orders`} /> : null}
        {c.features.quotes ? <Stat label="Quotes awaiting your answer" value={awaiting.length} href={`/portal/${slug}/quotes`} /> : null}
        {c.features.support ? <Stat label="New replies from us" value={answered.length} href={`/portal/${slug}/support`} /> : null}
      </div>

      {todayDetail.length ? (
        <Card>
          <CardHeader title="Today" description="Loads planned for today and tickets delivered so far, as recorded." />
          <CardBody>
            <ul className="divide-y divide-line" aria-label="Today">
              {todayDetail.map((d) => (
                <li key={d.id}>
                  {/* The whole row opens the order; the chevron and "Open order" say so (UX day-1). */}
                  <Link href={`/portal/${slug}/orders/${d.id}`} className="group flex items-center gap-3 rounded-xl py-3 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
                    <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0">
                        <span className="block font-semibold text-ink group-hover:underline">Order {d.number}{d.site ? <span className="font-normal text-muted"> · {d.site}</span> : null}</span>
                        {d.nextWindow ? <span className="block text-sm text-muted">Next load today {d.nextWindow}</span> : null}
                      </span>
                      <span className="text-sm tabular text-ink">{d.delivered} of {d.planned || d.delivered} load{(d.planned || d.delivered) === 1 ? "" : "s"} delivered{d.qty ? ` · ${d.qty}` : ""}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 text-sm font-semibold text-brand-fg">
                      <span className="hidden sm:inline">Open order</span>
                      <ChevronRight className="size-4" aria-hidden />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

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
      <span className="tabular mt-1 block text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] text-ink">{value}</span>
    </Link>
  );
}

/**
 * A demo company's portal opened by the platform owner (signed in as staff, not as a customer): offer the Testing Lab
 * preview right here, so the portal shows a demo customer's fictional orders, quotes and requests. The database allows
 * previews only for demo companies and the platform owner, for one hour, and audits them. Null for everyone else.
 */
async function demoPreviewOptions(slug: string): Promise<{ companyId: string; customers: Array<{ id: string; name: string; orders: number }> } | null> {
  if (!(await isPlatformAdmin())) return null;
  const supabase = await createClient();
  const { data: company } = await supabase.from("companies").select("id").eq("slug", slug).eq("is_demo", true).maybeSingle();
  if (!company) return null;
  const { data } = await supabase.rpc("platform_testing_demo", { p_company: company.id });
  const customers = ((data as { customers?: Array<{ id: string; name: string; orders: number }> } | null)?.customers ?? []).slice().sort((a, b) => b.orders - a.orders);
  return customers.length ? { companyId: company.id as string, customers } : null;
}

function PublicPage({ slug, company, noAccess, demoPreview = null }: { slug: string; company: PortalCompany & { public_page: boolean }; noAccess: boolean; demoPreview?: Awaited<ReturnType<typeof demoPreviewOptions>> }) {
  return (
    <div className="space-y-6">
      <div className="rounded-panel border border-line/70 bg-card shadow-card p-6 sm:p-8">
        <h1 className="text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] text-ink">{company.name} Customer Portal</h1>
        {company.public_page && company.welcome ? <p className="mt-3 max-w-2xl whitespace-pre-line text-[15px] text-muted">{company.welcome}</p> : null}
        <p className="mt-3 max-w-2xl text-[15px] text-muted">Customers can sign in to follow their orders and deliveries, see quotes, and ask us questions.</p>
        {noAccess && demoPreview ? (
          <form action={previewPortalAs} className="mt-5">
            <input type="hidden" name="company" value={demoPreview.companyId} />
            {/* The hint sits under the whole row so the button lines up with the field, not with the hint. */}
            <div className="flex flex-wrap items-end gap-2">
              <Field label="See the portal as a demo customer" htmlFor="portal-preview-customer">
                <Select id="portal-preview-customer" name="customer" required defaultValue={demoPreview.customers[0]?.id}>
                  {demoPreview.customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.orders ? ` · ${c.orders} ${c.orders === 1 ? "order" : "orders"}` : ""}</option>
                  ))}
                </Select>
              </Field>
              <SubmitButton pendingLabel="Opening…">Preview as customer</SubmitButton>
            </div>
            <p className="mt-1.5 text-sm text-muted">Fictional records. One hour, recorded in the platform audit; nothing is sent.</p>
          </form>
        ) : noAccess ? (
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

import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardList, FileClock, FileText, Plus, Siren, Truck } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { QuoteStatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FilterSelect } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/form";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";
import { addDays, formatDate, formatDateTime, isIsoDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { can, type Permission } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { listCustomerOptions } from "@/server/data/customers";
import { loadQuoteDashboard, loadRecentActivity } from "@/server/data/dashboard";
import { loadSummary } from "@/server/data/command-center";
import { fleetOverview } from "@/server/data/fleet";
import { countOrdersScheduledToday } from "@/server/data/orders";
import { getUserNames } from "@/server/data/quotes";
import { businessToday, getSettings } from "@/server/data/settings";
import type { QuoteListRow } from "@/server/data/types";

export const metadata = { title: "Dashboard" };

function Stat({ label, value, sub, href, tone = "default", icon }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: "default" | "warn" | "good"; icon: ReactNode }) {
  const body = (
    <div className={cn("flex h-full items-start gap-3 rounded-lg border bg-white p-4 shadow-xs transition-colors", href && "hover:border-charcoal/40", tone === "warn" ? "border-amber-300" : "border-line")}>
      <div className={cn("rounded-md p-2", tone === "warn" ? "bg-amber-50 text-amber-800" : tone === "good" ? "bg-green-50 text-green-800" : "bg-surface text-charcoal")}>{icon}</div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-muted">{label}</p>
        <p className="text-2xl font-black text-ink tabular">{value}</p>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

function QuoteMiniList({ rows, empty, today }: { rows: QuoteListRow[]; empty: string; today: string }) {
  if (rows.length === 0) return <p className="px-4 py-6 text-sm text-muted sm:px-5">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.slice(0, 8).map((q) => (
        <li key={q.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
          <div className="min-w-0">
            <Link href={`/quotes/${q.id}`} className="font-semibold tabular hover:text-brand hover:underline">{q.quote_number}</Link>
            <span className="ml-2 text-sm">{q.customer_name}</span>
            <div className="text-xs text-muted">
              {q.status === "sent" && q.last_sent_at ? `Sent ${formatDate(q.last_sent_at.slice(0, 10))} · ` : ""}
              {q.valid_until < today ? "Expired " : "Expires "}
              {formatDate(q.valid_until)}
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold tabular">{formatCents(q.total_cents)}</div>
            <QuoteStatusBadge status={q.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const PLANNED = [
  { label: "Deliveries in progress", phase: "Dispatch (Phase 4)" },
];

type Search = { from?: string; to?: string; customer?: string };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requireAccess();
  const sp = await searchParams;
  const [{ today, timezone }, settings] = await Promise.all([businessToday(), getSettings()]);
  const from = sp.from && isIsoDate(sp.from) ? sp.from : addDays(today, -30);
  const to = sp.to && isIsoDate(sp.to) ? sp.to : today;
  const canQuotes = can(access, "quotes.view");

  const canOrders = can(access, "orders.view");
  const canFleet = can(access, "fleet.view");
  const canCommand = ["dispatch.view", "tickets.view", "billing.view", "fleet.view"].some((p) => can(access, p as Permission));
  const [quotes, activity, names, customers, scheduledToday, fleet, command] = await Promise.all([
    canQuotes ? loadQuoteDashboard({ from, to, customer: sp.customer }, today, settings.quote_followup_days) : Promise.resolve(null),
    loadRecentActivity(can(access, "audit.view")),
    getUserNames(),
    canQuotes ? listCustomerOptions() : Promise.resolve([]),
    canOrders ? countOrdersScheduledToday() : Promise.resolve(null),
    canFleet ? fleetOverview() : Promise.resolve(null),
    canCommand ? loadSummary() : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Good to see you${access.fullName ? `, ${access.fullName.split(" ")[0]}` : ""}. Today is ${formatDate(today)}.`}
        actions={
          can(access, "quotes.edit") && (
            <ButtonLink href="/quotes/new" icon={<Plus className="size-4" />}>New quote</ButtonLink>
          )
        }
      />

      {quotes && (
        <>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white px-4 py-3">
            <div>
              <label htmlFor="from" className="mb-1 block text-xs font-semibold text-muted uppercase">Decisions from</label>
              <Input id="from" name="from" type="date" defaultValue={from} className="w-40" />
            </div>
            <div>
              <label htmlFor="to" className="mb-1 block text-xs font-semibold text-muted uppercase">To</label>
              <Input id="to" name="to" type="date" defaultValue={to} className="w-40" />
            </div>
            <FilterSelect name="customer" label="Customer" value={sp.customer} options={[{ value: "", label: "All customers" }, ...customers.map((c) => ({ value: c.id, label: c.name }))]} />
            <button type="submit" className={buttonClasses("dark")}>Apply</button>
            <Link href="/dashboard" className={buttonClasses("ghost")}>Reset</Link>
          </form>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={<FileClock className="size-5" />} label="Sent, awaiting response" value={quotes.awaiting.count} sub={formatCents(quotes.awaiting.totalCents)} href="/quotes?status=sent" />
            <Stat icon={<AlertTriangle className="size-5" />} label="Need follow-up" value={quotes.followUp.length + quotes.pastExpiration.length} sub={`${quotes.followUp.length} no reply in ${settings.quote_followup_days}+ days · ${quotes.pastExpiration.length} past expiration`} tone={quotes.followUp.length + quotes.pastExpiration.length > 0 ? "warn" : "default"} />
            <Stat icon={<CheckCircle2 className="size-5" />} label={`Accepted ${formatDate(from)} – ${formatDate(to)}`} value={quotes.accepted.count} sub={`${formatCents(quotes.accepted.totalCents)}${quotes.winRate !== null ? ` · ${quotes.winRate}% of decided` : ""}`} tone="good" href="/quotes?status=accepted" />
            <Stat icon={<FileText className="size-5" />} label="Drafts not yet sent" value={quotes.drafts.count} sub={`${formatCents(quotes.drafts.totalCents)}${quotes.staleDrafts.length ? ` · ${quotes.staleDrafts.length} untouched 7+ days` : ""}`} href="/quotes?status=draft" />
          </div>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Quotes awaiting follow-up" description={`Sent with no response for ${settings.quote_followup_days}+ days, or past expiration.`} />
              <QuoteMiniList rows={[...quotes.pastExpiration, ...quotes.followUp]} empty="Nothing needs follow-up right now." today={today} />
            </Card>
            <Card>
              <CardHeader title="Recently accepted" description="Open a quote and choose “Convert to order” to create its order." />
              <QuoteMiniList rows={quotes.recentAccepted} empty="No quotes accepted in this period." today={today} />
            </Card>
            <Card>
              <CardHeader title="Expiring in the next 7 days" />
              <QuoteMiniList rows={quotes.expiringSoon} empty="No sent quotes expire this week." today={today} />
            </Card>
            <Card>
              <CardHeader title="Recent activity" />
              {activity.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted sm:px-5">No activity yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {activity.map((a) => (
                    <li key={a.id} className="px-4 py-2.5 text-sm sm:px-5">
                      {a.entity_type === "quote" && a.entity_id ? (
                        <Link href={`/quotes/${a.entity_id}`} className="hover:underline">{a.summary}</Link>
                      ) : a.entity_type === "order" && a.entity_id && canOrders ? (
                        <Link href={`/orders/${a.entity_id}`} className="hover:underline">{a.summary}</Link>
                      ) : a.entity_type === "customer" && a.entity_id ? (
                        <Link href={`/customers/${a.entity_id}`} className="hover:underline">{a.summary}</Link>
                      ) : (
                        <span>{a.summary}</span>
                      )}
                      <div className="text-xs text-muted">
                        {formatDateTime(a.occurred_at, timezone)} · {a.actor_id ? names[a.actor_id] ?? "Former user" : "System"}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      <Card className="mt-5">
        <CardHeader title="Operations" description="Live figures. Everything that needs attention is listed in the Command Center. Nothing here is estimated." />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {scheduledToday !== null && (
            <Stat icon={<CalendarClock className="size-5" />} label="Orders scheduled today" value={scheduledToday} sub="Open the list for times and sites" href="/orders?when=today" />
          )}
          {command && (
            <Stat
              icon={<Siren className="size-5" />}
              label="Command Center"
              value={command.ok ? `${command.data.exceptions.total} open` : "Not available"}
              sub={command.ok ? `${command.data.exceptions.urgent} urgent · open the attention queue` : "The figures could not be loaded"}
              href="/command-center"
              tone={command.ok && command.data.exceptions.urgent > 0 ? "warn" : "default"}
            />
          )}
          {fleet && (
            <Stat
              icon={<Truck className="size-5" />}
              label="Fleet ready today"
              value={`${fleet.trucks.inService} trucks · ${fleet.drivers.ready} drivers`}
              sub={`${fleet.trucks.outOfService.length + fleet.trailers.outOfService.length} out of service · ${fleet.drivers.notReady.length} drivers not eligible`}
              href="/fleet"
              tone={fleet.trucks.outOfService.length + fleet.drivers.notReady.length > 0 ? "warn" : "default"}
            />
          )}
          {PLANNED.map((p) => (
            <div key={p.label} className="flex items-start gap-3 rounded-md border border-dashed border-line px-3 py-3">
              {p.label.includes("Fleet") ? <Truck className="mt-0.5 size-5 text-muted" aria-hidden /> : p.label.includes("today") ? <CalendarClock className="mt-0.5 size-5 text-muted" aria-hidden /> : <ClipboardList className="mt-0.5 size-5 text-muted" aria-hidden />}
              <div>
                <p className="font-semibold text-ink">{p.label}</p>
                <p className="text-sm text-muted">Not available yet — {p.phase}</p>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
    </>
  );
}

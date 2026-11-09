import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowRight, CircleDollarSign, Truck, Wrench } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState } from "@/components/ui/states";
import { balanceCents, invoiceState } from "@/lib/billing/invoices";
import { heldTotal, missedTotal } from "@/lib/billing/leaks";
import { briefingActions, greetingFor, type BriefingAction } from "@/lib/briefing";
import { cn } from "@/lib/cn";
import { addDays, formatDateLong } from "@/lib/dates";
import { isLong, waitMinutes } from "@/lib/dispatch/wait-times";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { loadSummary } from "@/server/data/command-center";
import { listInvoices } from "@/server/data/invoices";
import { listLeaks } from "@/server/data/leaks";
import { shownName } from "@/server/data/profile";
import { businessToday } from "@/server/data/settings";
import { listStopTimes, waitTimeSettings } from "@/server/data/wait-times";
import { createClient } from "@/server/supabase/server";
import { loadOutlook } from "@/server/data/live";
import { getSay } from "@/server/industry";

export const metadata = { title: "Morning briefing" };

const TONE: Record<BriefingAction["tone"], string> = { critical: "bg-critical", warn: "bg-amber-500", info: "bg-brand" };

/**
 * Owner morning briefing (B116): yesterday's results, today's picture and the three things to do first, each with the
 * place that fixes it. Every figure comes from the records the person may see; nothing is done from here.
 */
export default async function BriefingPage() {
  const say = await getSay();
  const access = await requireAccess();
  if (!can(access, "dispatch.view") && !can(access, "billing.view")) redirect("/command-center");
  const { today, timezone } = await businessToday();
  const yesterday = addDays(today, -1);
  const billing = can(access, "billing.view");
  const supabase = await createClient();
  const [name, summary, daily, ops, invoices, leaks, waits, waitCfg, outlook] = await Promise.all([
    shownName(access),
    loadSummary(),
    supabase.rpc("my_daily_summary").then((r) => (r.error ? null : (r.data as { tomorrow_without_truck?: number; tomorrow_loads?: number } | null))),
    supabase.rpc("report_operations", { p_from: yesterday, p_to: yesterday }).then((r) => (r.error ? null : (r.data as { value?: { verified_value_cents: number }; loads?: { delivered?: number } } | null))),
    billing ? listInvoices().catch(() => null) : Promise.resolve(null),
    billing ? listLeaks().catch(() => null) : Promise.resolve(null),
    listStopTimes(yesterday, yesterday, timezone).catch(() => null),
    waitTimeSettings().catch(() => ({ installed: false, freeMinutes: null })),
    // Today's loads against the shared readiness rule (owner 2026-11-09, WK1), the same figures as the Command Center.
    can(access, "dispatch.view") ? loadOutlook(today, false, 1).catch(() => null) : Promise.resolve(null),
  ]);
  const s = summary.ok ? summary.data : null;
  // Loads today not yet ended: without a truck, and on a truck or trailer that cannot run today. "All covered" only
  // when both are zero; without today's outlook, open assignment problems keep it from being claimed.
  const day = outlook?.days[0] ?? null;
  const needTruck = day ? day.unassigned : s?.unassigned_loads ?? 0;
  const cannotRun = day ? day.conflicts : null;
  const covered = needTruck === 0 && (cannotRun === null ? !s?.assignment_problems : cannotRun === 0);
  const overdue = invoices ? invoices.filter((i) => invoiceState(i, today) === "overdue") : null;
  const actions = briefingActions({
    urgentOrders: s?.urgent_orders ?? null,
    loadsTodayUnassigned: s?.unassigned_loads ?? null,
    assignmentProblems: s?.assignment_problems ?? null,
    trucksDown: s?.trucks_out_of_service ?? null,
    driverReports: s?.driver_reports ?? null,
    ticketsToReview: s?.tickets_to_review ?? null,
    missingTickets: s?.missing_tickets ?? null,
    billingReady: s?.billing_ready ?? null,
    billingBlocked: s?.billing_blocked ?? null,
    overdueInvoices: overdue ? { count: overdue.length, cents: overdue.reduce((n, i) => n + balanceCents(i), 0) } : null,
    revenueToCheck: leaks ? { count: leaks.length, cents: missedTotal(leaks), heldCents: heldTotal(leaks) } : null,
    tomorrowUnassigned: daily?.tomorrow_without_truck ?? null,
    longWaitsYesterday: waits ? waits.filter((w) => isLong(waitMinutes(w), waitCfg.freeMinutes)).length : null,
  });
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(new Date()));
  const first = actions.slice(0, 3);
  const rest = actions.slice(3);

  return (
    <>
      <PageHeader
        title={`${greetingFor(hour)}${name ? `, ${name.split(" ")[0]}` : ""}`}
        description={`${formatDateLong(today)}. Yesterday's results, today's picture and what to do first, from your own records.`}
        actions={<ButtonLink href="/command-center" variant="secondary">Command Center</ButtonLink>}
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {billing && (
          <StatTile icon={<CircleDollarSign />} label="Delivered yesterday" value={ops?.value ? formatCents(ops.value.verified_value_cents) : "–"} muted={!ops?.value?.verified_value_cents}>
            {say("Verified value of accepted tickets")}
          </StatTile>
        )}
        <StatTile icon={<Truck />} tone={cannotRun ? "critical" : covered ? "green" : "amber"} label="Loads today" value={s?.loads_today ?? "–"}>
          {s?.loads_today == null ? "Not available" : covered ? "All covered" : (
            <Link href={`/dispatch?date=${today}`} className="font-semibold underline-offset-2 hover:underline" data-testid="briefing-not-covered">
              {[
                needTruck ? `${needTruck} without a truck` : null,
                cannotRun ? `${cannotRun} on ${cannotRun === 1 ? "a truck that cannot" : "trucks that cannot"} run` : null,
                cannotRun === null && s.assignment_problems ? `${s.assignment_problems} assignment problem${s.assignment_problems === 1 ? "" : "s"}` : null,
              ].filter(Boolean).join(" · ")}
            </Link>
          )}
        </StatTile>
        <StatTile icon={<Wrench />} tone={s?.trucks_out_of_service ? "amber" : "neutral"} label="Trucks down" value={s?.trucks_out_of_service ?? "–"} muted={!s?.trucks_out_of_service}>
          Out of service today
        </StatTile>
        {billing && (
          <StatTile icon={<AlertTriangle />} tone={overdue?.length ? "amber" : "neutral"} label="Overdue" value={overdue ? formatCents(overdue.reduce((n, i) => n + balanceCents(i), 0)) : "–"} muted={!overdue?.length}>
            {overdue ? `${overdue.length} invoice${overdue.length === 1 ? "" : "s"} past terms` : "Invoicing not in use"}
          </StatTile>
        )}
      </div>

      <Card className="mb-5">
        <CardHeader title="Do these first" description="Ranked by urgency and money at stake. Each opens the place that fixes it." />
        {first.length === 0 ? (
          <EmptyState title="Nothing needs you right now" description="No urgent orders, uncovered loads, overdue invoices or missed billing. Have a good day." />
        ) : (
          <ol className="divide-y divide-line border-t border-line" aria-label="Do these first">
            {first.map((a, i) => (
              <li key={a.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 sm:px-6">
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold text-white", TONE[a.tone])} aria-hidden>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">{say(a.title)}</p>
                  <p className="text-sm text-muted">{say(a.detail)}</p>
                </div>
                <ButtonLink href={a.href} size="sm" variant={i === 0 ? "primary" : "secondary"}>{say(a.cta)}</ButtonLink>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {rest.length > 0 && (
        <Card>
          <CardHeader title="Also worth a look" />
          <ul className="divide-y divide-line border-t border-line" aria-label="Also worth a look">
            {rest.map((a) => (
              <li key={a.key}>
                <Link href={a.href} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-ink/[0.03] sm:px-6">
                  <span className={cn("size-2 shrink-0 rounded-full", TONE[a.tone])} aria-hidden />
                  <span className="min-w-0 flex-1 text-sm"><span className="font-medium text-ink">{say(a.title)}</span> <span className="text-muted">· {say(a.detail)}</span></span>
                  <ArrowRight className="size-4 shrink-0 text-muted/60" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ErrorState, Notice } from "@/components/ui/states";
import { ConsolePageHeader, ConsoleTabs, DataCell, DataHead, DataRow, DataTable, Panel, PanelHeader, StatGrid, groupOf, type Stat } from "@/components/admin/ui";
import { formatDate } from "@/lib/dates";
import { REVENUE_RANGES, barHeights, changeText, customersSubText, monthLabel, namesText, revenueRange, type RevenueReport } from "@/lib/platform/revenue";
import { usd } from "@/lib/site/pricing";
import { requirePlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Revenue over time" };

const AGREED = "Agreed, not collected";
const INTRO = "Month by month, the monthly amounts agreed with live customers, from the plans and terms recorded on each company. Taviron has no payment system: nothing here was charged or received.";

/**
 * Revenue over time (PC2, owner 2026-11-14: "Yes, Admin only"). AGREED monthly revenue from recorded agreements
 * (public.platform_revenue_by_month, Admin only in the database too), with new and lost customers per month and the
 * renewals and plan changes coming up. Labelled "agreed, not collected" everywhere: there is no payment system.
 */
export default async function RevenuePage({ searchParams }: { searchParams: Promise<{ months?: string }> }) {
  await requirePlatformAdmin();
  const months = revenueRange((await searchParams).months);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_revenue_by_month", { p_months: months });
  const header = <ConsolePageHeader eyebrow={groupOf("/admin/revenue")} title="Revenue over time" description={INTRO} badges={<Badge tone="amber">{AGREED}</Badge>} />;
  if (error) {
    const missing = ["PGRST202", "42883"].includes(error.code ?? "");
    return (
      <>
        {header}
        <ErrorState
          title={missing ? "Not available yet" : "Revenue could not be loaded"}
          description={missing ? "Revenue over time is not available on this database yet. Agreed amounts are still on each company's page." : "Nothing is shown rather than guessed. Reload to try again."}
        />
      </>
    );
  }
  const r = data as RevenueReport;
  const list = r.months;
  const now = list[list.length - 1];
  const notRecorded = list.some((m) => m.not_recorded > 0);
  const heights = barHeights(list);
  const stats: Stat[] = now ? [
    { label: "Agreed monthly revenue now", value: usd(now.agreed_cents), sub: `${AGREED} · ${now.customers} live customer${now.customers === 1 ? "" : "s"}` },
    { label: "Change this month", value: changeText(now.change_cents), sub: list.length > 1 ? `Since the end of ${monthLabel(list[list.length - 2].month)}` : "Compared with the month before" },
    { label: "New customers this month", value: now.new.length, sub: namesText(now.new) || "Nobody went live yet this month" },
    { label: "Lost customers this month", value: now.lost.length, sub: namesText(now.lost) || "No cancellations this month", tone: now.lost.length ? "attention" : "default" },
  ] : [];

  return (
    <>
      {header}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <ConsoleTabs label="How many months" items={REVENUE_RANGES.map((n) => ({ href: `/admin/revenue?months=${n}`, label: `${n} months`, current: n === months }))} />
        <p className="text-xs text-muted">Each month shows the position on its last day; this month shows today.</p>
      </div>
      <StatGrid label="This month" stats={stats} className="mb-5" />
      {notRecorded && (
        <div className="mb-5">
          <Notice tone="warning" title="Some amounts are not recorded">
            A live customer has no recorded agreement for part of this period, so that month counts them without an amount instead of guessing. Set the plan and terms on the company&apos;s page to record it from now on.
          </Notice>
        </div>
      )}

      <Panel className="mb-5">
        <PanelHeader title="Agreed monthly revenue by month" description={`${AGREED}. The table below has every figure.`} />
        <div className="px-5 pb-5 sm:px-6" aria-hidden>
          <div className="flex h-44 items-end gap-0.5 border-b border-line">
            {list.map((m, i) => (
              <div key={m.month} className="group relative flex h-full flex-1 items-end">
                <div className={`w-full rounded-t ${m.current ? "bg-brand/60" : "bg-brand"}`} style={{ height: `${Math.max(heights[i], m.agreed_cents > 0 ? 2 : 0)}%` }} />
                <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border border-line bg-card px-2 py-1 text-xs whitespace-nowrap text-ink shadow-sm group-hover:block">
                  {monthLabel(m.month)}: {usd(m.agreed_cents)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-0.5 text-[11px] text-muted">
            {list.map((m, i) => (
              <span key={m.month} className="flex-1 text-center tabular">{list.length <= 12 || i % 3 === 0 || m.current ? monthLabel(m.month).replace(/ \d{4}$/, "") : ""}</span>
            ))}
          </div>
        </div>
      </Panel>

      <DataTable
        aria-label="Agreed monthly revenue by month"
        className="mb-5"
        head={<><DataHead>Month</DataHead><DataHead align="right">Agreed monthly revenue</DataHead><DataHead align="right">Change</DataHead><DataHead align="right">Live customers</DataHead><DataHead>New</DataHead><DataHead>Lost</DataHead></>}
      >
        {[...list].reverse().map((m) => (
          <DataRow key={m.month}>
            <DataCell primary className="whitespace-nowrap"><span className="font-semibold text-ink">{monthLabel(m.month)}</span>{m.current ? <span className="ml-2 text-xs text-muted">so far</span> : null}</DataCell>
            <DataCell label="Agreed" align="right" className="tabular whitespace-nowrap">{usd(m.agreed_cents)}{m.not_recorded ? <span className="block text-xs text-muted">{m.not_recorded} not recorded</span> : null}</DataCell>
            <DataCell label="Change" align="right" className="tabular whitespace-nowrap">{changeText(m.change_cents)}</DataCell>
            <DataCell label="Customers" align="right" className="tabular">{m.customers}{customersSubText(m) ? <span className="block text-xs text-muted">{customersSubText(m)}</span> : null}</DataCell>
            <DataCell label="New" empty={!m.new.length} className="text-sm">{m.new.length ? <><span className="font-semibold tabular">{m.new.length}</span> <span className="text-muted">{namesText(m.new)}</span></> : <span className="text-muted">–</span>}</DataCell>
            <DataCell label="Lost" empty={!m.lost.length} className="text-sm">{m.lost.length ? <><span className="font-semibold tabular">{m.lost.length}</span> <span className="text-muted">{namesText(m.lost)}</span></> : <span className="text-muted">–</span>}</DataCell>
          </DataRow>
        ))}
      </DataTable>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Renewals in the next 90 days" description="Annual terms only. Monthly terms continue each month until canceled." />
          {r.renewals.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted sm:px-6">No annual renewals in the next 90 days.</p>
          ) : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Upcoming renewals">
              {r.renewals.map((x) => (
                <li key={x.company_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                  <Link href={`/admin/companies/${x.company_id}`} className="font-semibold text-ink hover:underline">{x.name}</Link>
                  {x.renewal_off ? <Badge tone="amber">Not renewing</Badge> : null}
                  <span className="ml-auto text-xs text-muted tabular">{formatDate(x.renews_on)} · in {x.days} day{x.days === 1 ? "" : "s"} · {x.agreed_monthly_cents === null ? "amount not recorded" : `${usd(x.agreed_monthly_cents)} a month`}{x.plan ? ` · ${x.plan}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Plan changes coming up" description="Scheduled by the team with the customer's agreed new amount." />
          {r.scheduled_changes.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted sm:px-6">No plan changes scheduled.</p>
          ) : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Scheduled plan changes">
              {r.scheduled_changes.map((x) => (
                <li key={`${x.company_id}:${x.effective_on}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                  <Link href={`/admin/companies/${x.company_id}`} className="font-semibold text-ink hover:underline">{x.name}</Link>
                  <span className="ml-auto text-xs text-muted tabular">{formatDate(x.effective_on)} · {x.current_cents === null ? "–" : usd(x.current_cents)} → {usd(x.agreed_monthly_cents)} a month{x.plan ? ` · ${x.plan}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
          {r.not_live_yet.companies > 0 && (
            <p className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
              Not counted yet: {r.not_live_yet.companies} compan{r.not_live_yet.companies === 1 ? "y" : "ies"} still onboarding, {usd(r.not_live_yet.agreed_cents)} a month agreed once live.
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}

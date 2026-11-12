import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { CardBody, CardHeader } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/dates";
import { TIMELINE_SOURCES, healthVerdict, stageLabel, timelineText, weekCompare, type CompanyHealth, type TimelineItem, type UsageWeek } from "@/lib/platform/console";
import { cn } from "@/lib/cn";

// The company page's health, usage and timeline (PC1). Counts only, from the platform_company_* reads; nothing here
// shows a company's business records. Each part says when its data is missing instead of showing zero.

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-ink tabular">{value}</dd>
      {sub ? <dd className="text-xs text-muted">{sub}</dd> : null}
    </div>
  );
}

/** The verdict as a badge (also for the directory column). */
export function HealthBadge({ health, now }: { health: CompanyHealth; now: number }) {
  const v = healthVerdict(health, now);
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

export function CompanyHealthCard({ health, now }: { health: CompanyHealth; now: number }) {
  const v = healthVerdict(health, now);
  const alerts = health.alerts_critical + health.alerts_action;
  return (
    <>
      <CardHeader
        title="Health at a glance"
        description="How much this company is using Taviron, from counts only. Taviron staff are never counted."
        actions={<Badge tone={v.tone}>{v.label}</Badge>}
      />
      <CardBody className="space-y-4">
        <p className="text-sm text-ink" data-testid="health-verdict">{v.detail}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Fact label="Last sign-in" value={health.last_sign_in_at ? formatDateTime(health.last_sign_in_at) : "Nobody yet"} />
          <Fact label="People active" value={`${health.active_7d} in 7 days`} sub={`${health.active_30d} in 30 days · ${health.members} can sign in`} />
          <Fact label="Last change by the company" value={health.last_activity_at ? formatDateTime(health.last_activity_at) : "None recorded"} />
          <Fact label="Loads" value={String(health.loads_this_week)} sub={weekCompare(health.loads_this_week, health.loads_last_week)} />
          <Fact label="Tickets delivered" value={String(health.tickets_this_week)} sub={weekCompare(health.tickets_this_week, health.tickets_last_week)} />
          <Fact label="Open alerts" value={alerts ? `${health.alerts_critical} critical · ${health.alerts_action} to act on` : "None"} />
          <Fact label="Support visits" value={`${health.support_visits_30d} in 30 days`} sub={health.last_support_visit_at ? `Last ${formatDateTime(health.last_support_visit_at)}` : "Never visited"} />
          <Fact label="Stage" value={stageLabel(health.stage)} />
          <Fact label="Week" value={`From ${formatDate(health.week_start)}`} sub="Monday first, the company's time zone" />
        </dl>
      </CardBody>
    </>
  );
}

/** Weekly usage as a small table with bars (the numbers are always written out). */
export function UsageTrends({ weeks }: { weeks: UsageWeek[] }) {
  const max = {
    loads: Math.max(1, ...weeks.map((w) => w.loads)),
    tickets: Math.max(1, ...weeks.map((w) => w.tickets)),
    active_people: Math.max(1, ...weeks.map((w) => w.active_people)),
    ai_requests: Math.max(1, ...weeks.map((w) => w.ai_requests)),
  };
  const cols = [
    { key: "loads", label: "Loads" },
    { key: "tickets", label: "Tickets" },
    { key: "active_people", label: "People making changes" },
    { key: "ai_requests", label: "AI requests" },
  ] as const;
  const empty = weeks.every((w) => !w.loads && !w.tickets && !w.active_people && !w.ai_requests);
  return (
    <>
      <CardHeader title="Usage by week" description="The last 8 weeks, oldest first. Counts only: loads planned, tickets delivered, people who made a recorded change, and AI requests." />
      {empty ? (
        <CardBody><p className="text-sm text-muted">Nothing recorded in the last 8 weeks.</p></CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm" aria-label="Usage by week">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th scope="col" className="px-5 py-2 font-medium sm:px-6">Week of</th>
                {cols.map((c) => <th key={c.key} scope="col" className="px-3 py-2 font-medium">{c.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {weeks.map((w) => (
                <tr key={w.week_start}>
                  <th scope="row" className="px-5 py-2 text-left font-medium whitespace-nowrap text-ink sm:px-6">{formatDate(w.week_start)}</th>
                  {cols.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span className="w-8 text-right tabular text-ink">{w[c.key]}</span>
                        <span className="h-1.5 flex-1 rounded-full bg-surface" aria-hidden>
                          <span className="block h-1.5 rounded-full bg-strong" style={{ width: `${Math.round((w[c.key] / max[c.key]) * 100)}%` }} />
                        </span>
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const SOURCE_TONE: Record<TimelineItem["source"], "blue" | "gray" | "amber" | "green" | "brand"> = {
  lead: "brand", platform: "gray", onboarding: "blue", support: "amber", subscription: "green",
};

/** Everything that happened with this customer, newest first. Display only. */
export function CompanyTimeline({ items, olderHref }: { items: TimelineItem[]; olderHref: string | null }) {
  return (
    <>
      <CardHeader title="Customer timeline" description="Everything that happened with this customer, newest first: the lead, Taviron's actions, onboarding, support visits and subscription events." />
      {items.length === 0 ? (
        <CardBody><p className="text-sm text-muted">Nothing recorded yet.</p></CardBody>
      ) : (
        <ol className="divide-y divide-line" aria-label="Customer timeline">
          {items.map((i, n) => {
            const t = timelineText(i);
            return (
              <li key={`${i.at}:${n}`} className="grid grid-cols-1 gap-1 px-5 py-2.5 text-sm sm:grid-cols-[9.5rem_1fr] sm:gap-4 sm:px-6">
                <span className="text-xs text-muted tabular sm:pt-0.5">{formatDateTime(i.at)}</span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={SOURCE_TONE[i.source]}>{TIMELINE_SOURCES[i.source]}</Badge>
                    <span className="font-semibold text-ink">{t.title}</span>
                  </span>
                  {t.detail ? <span className="mt-0.5 block break-words text-muted">{t.detail}</span> : null}
                  <span className={cn("mt-0.5 block text-xs text-muted")}>{i.actor}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {olderHref ? <CardBody className="border-t border-line"><Link href={olderHref} className="text-sm font-semibold text-brand-fg hover:underline">Show older entries</Link></CardBody> : null}
    </>
  );
}

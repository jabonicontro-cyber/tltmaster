import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { ExceptionCard } from "@/components/command-center/exception-card";
import { MetricGrid } from "@/components/command-center/metric-grid";
import { RefreshButton } from "@/components/command-center/refresh-button";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { EXCEPTION_KINDS, KIND_LABELS, PRIORITY_RULES, metricCards, type ExceptionKind } from "@/lib/command-center/rules";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { ACTIVITY_PAGE_SIZE, QUEUE_PAGE_SIZE, loadActivity, loadAssigneeOptions, loadQueue, loadSummary } from "@/server/data/command-center";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Command Center" };

type Search = { kind?: string; mine?: string; page?: string; activity?: string };

const SOURCE_PERMISSIONS = ["dispatch.view", "tickets.view", "billing.view", "fleet.view"] as const;

const positive = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 1;
};

function activityHref(e: { entity_type: string; entity_id: string | null }) {
  if (!e.entity_id) return null;
  switch (e.entity_type) {
    case "order": return `/orders/${e.entity_id}`;
    case "truck": return `/fleet/trucks/${e.entity_id}`;
    case "trailer": return `/fleet/trailers/${e.entity_id}`;
    case "driver": return `/fleet/drivers/${e.entity_id}`;
    default: return null;
  }
}

export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requireAccess();
  if (!SOURCE_PERMISSIONS.some((p) => can(access, p))) redirect("/no-access?missing=dispatch.view");
  const sp = await searchParams;
  const kind = sp.kind && (EXCEPTION_KINDS as readonly string[]).includes(sp.kind) ? (sp.kind as ExceptionKind) : undefined;
  const mine = sp.mine === "1";
  const page = positive(sp.page);
  const activityPage = positive(sp.activity);
  const canAssign = can(access, "exceptions.assign");

  const [summary, queue, activity, people, names, { timezone }] = await Promise.all([
    loadSummary(),
    loadQueue({ kind, mine, page }),
    loadActivity(access, activityPage),
    canAssign ? loadAssigneeOptions() : Promise.resolve([]),
    getUserNames(),
    businessToday(),
  ]);
  const now = new Date();
  const href = (p: { kind?: ExceptionKind; mine?: boolean; page?: number; activity?: number }) => {
    const q = new URLSearchParams();
    if (p.kind) q.set("kind", p.kind);
    if (p.mine) q.set("mine", "1");
    if (p.page && p.page > 1) q.set("page", String(p.page));
    if (p.activity && p.activity > 1) q.set("activity", String(p.activity));
    const s = q.toString();
    return `/command-center${s ? `?${s}` : ""}`;
  };
  const visibleKinds = summary.ok ? EXCEPTION_KINDS.filter((k) => k in summary.data.by_kind || (
    { unassigned_load: summary.data.unassigned_loads, assignment_problem: summary.data.assignment_problems, missing_ticket: summary.data.missing_tickets,
      ticket_review: summary.data.tickets_to_review, billing_blocked: summary.data.billing_blocked, equipment_out_of_service: summary.data.trucks_out_of_service }[k] !== null)) : [];

  return (
    <>
      <PageHeader
        title="Command Center"
        description="What needs attention across dispatch, tickets, billing and the fleet — why it matters, who handles it, and where to fix it. Everything here is read live from the records."
        actions={<RefreshButton />}
      />

      {/* Status strip */}
      {summary.ok ? (
        <section aria-label="Attention summary" className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-charcoal px-4 py-3 text-white sm:px-5">
          <p className="text-lg font-black">
            {summary.data.exceptions.total === 0 ? "Nothing needs attention" : `${summary.data.exceptions.total} item${summary.data.exceptions.total === 1 ? "" : "s"} need attention`}
          </p>
          {summary.data.exceptions.urgent > 0 && (
            <Link href={href({}) + "#attention"} className="rounded bg-brand px-2 py-0.5 text-sm font-bold">{summary.data.exceptions.urgent} urgent</Link>
          )}
          {summary.data.exceptions.mine > 0 && (
            <Link href={href({ mine: true }) + "#attention"} className="text-sm font-semibold underline">{summary.data.exceptions.mine} assigned to you</Link>
          )}
          <p className="ml-auto text-xs text-white/70">As of {formatDateTime(summary.data.as_of, timezone)}</p>
        </section>
      ) : null}

      <section aria-label="Operational overview" className="mb-6">
        {summary.ok ? (
          <MetricGrid cards={metricCards(summary.data)} />
        ) : (
          <ErrorState title="The overview could not be loaded" description="No figures are shown rather than guessed. Try again in a moment." action={<Link href={href({ kind, mine, page })} className={buttonClasses("secondary")}>Try again</Link>} />
        )}
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <div id="attention" className="scroll-mt-20">
            <CardHeader
              title="Attention queue"
              description="One item per underlying problem, most urgent and oldest first. An item leaves the queue only when its record is fixed in its own module."
            />
          </div>
          <nav aria-label="Filter the queue" className="flex flex-wrap gap-2 border-b border-line px-4 py-3 sm:px-5">
            <Chip href={href({}) + "#attention"} active={!kind && !mine} label="All" count={summary.ok ? summary.data.exceptions.total : undefined} />
            {visibleKinds.map((k) => (
              <Chip key={k} href={href({ kind: k }) + "#attention"} active={kind === k && !mine} label={KIND_LABELS[k]} count={summary.ok ? summary.data.by_kind[k] ?? 0 : undefined} />
            ))}
            {summary.ok && summary.data.exceptions.mine > 0 && <Chip href={href({ mine: true }) + "#attention"} active={mine} label="Assigned to me" count={summary.data.exceptions.mine} />}
          </nav>
          <details className="border-b border-line px-4 py-2 text-sm sm:px-5">
            <summary className="cursor-pointer font-semibold text-muted">How priority is decided</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              {PRIORITY_RULES.map((r) => <li key={r}>{r}</li>)}
              <li>Within a priority, the oldest problem comes first. Age is shown only when it is known from the record.</li>
            </ul>
          </details>
          {!queue.ok ? (
            <div className="p-4 sm:p-5">
              <ErrorState title="The attention queue could not be loaded" description="Open the modules directly or try again." action={<Link href={href({ kind, mine, page })} className={buttonClasses("secondary")}>Try again</Link>} />
            </div>
          ) : queue.data.items.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="size-6" />}
              title={kind || mine ? "Nothing in this view" : "Nothing needs attention"}
              description={kind || mine ? "Choose “All” to see every open item." : "No missing tickets, unassigned loads, tickets to review, billing blocks, out-of-service equipment or assignment problems you can see."}
            />
          ) : (
            <>
              <ul className="divide-y divide-line" aria-label="Attention items">
                {queue.data.items.map((item) => (
                  <ExceptionCard
                    key={item.exception_key}
                    item={item}
                    can={{ ticketsEdit: can(access, "tickets.edit"), dispatch: can(access, "dispatch.view"), assign: canAssign }}
                    people={people}
                    timezone={timezone}
                    now={now}
                  />
                ))}
              </ul>
              <Pagination page={page} pageSize={QUEUE_PAGE_SIZE} total={queue.data.total} hrefFor={(p) => href({ kind, mine, page: p }) + "#attention"} />
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" description="Orders, dispatch, tickets and fleet, as your role allows." />
          {!activity.ok ? (
            <div className="p-4"><ErrorState title="Activity could not be loaded" /></div>
          ) : activity.data.rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted sm:px-5">No activity yet.</p>
          ) : (
            <>
              <ul className="divide-y divide-line" aria-label="Recent activity">
                {activity.data.rows.map((a) => {
                  const link = activityHref(a);
                  return (
                    <li key={a.id} className="px-4 py-2.5 text-sm sm:px-5">
                      {link ? <Link href={link} className="break-words hover:underline">{a.summary}</Link> : <span className="break-words">{a.summary}</span>}
                      <div className="text-xs text-muted">{formatDateTime(a.occurred_at, timezone)} · {a.actor_id ? names[a.actor_id] ?? "Former user" : "System"}</div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex justify-between gap-2 px-4 py-3 sm:px-5">
                {activityPage > 1 ? <Link href={href({ kind, mine, page, activity: activityPage - 1 })} className={buttonClasses("secondary", "sm")}>Newer</Link> : <span />}
                {activity.data.hasMore && <Link href={href({ kind, mine, page, activity: activityPage + 1 })} className={buttonClasses("secondary", "sm")}>Older</Link>}
              </div>
              <p className="px-4 pb-3 text-xs text-muted sm:px-5">{ACTIVITY_PAGE_SIZE} per page.</p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function Chip({ href, active, label, count }: { href: string; active: boolean; label: string; count?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold", active ? "border-charcoal bg-charcoal text-white" : "border-line bg-white text-ink hover:border-charcoal/40")}
    >
      {label}
      {count !== undefined && <Badge tone={active ? "dark" : count > 0 ? "amber" : "gray"}>{count}</Badge>}
    </Link>
  );
}

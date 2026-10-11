import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, Plus, Route } from "lucide-react";
import { ExceptionCard } from "@/components/command-center/exception-card";
import { MetricGrid } from "@/components/command-center/metric-grid";
import { RefreshButton } from "@/components/command-center/refresh-button";
import { SalesSection } from "@/components/command-center/sales-section";
import { SectionLayout, type Section } from "@/components/command-center/section-layout";
import { Badge } from "@/components/ui/badge";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { EXCEPTION_KINDS, KIND_LABELS, PRIORITY_RULES, metricCards, type ExceptionKind, type MetricCard } from "@/lib/command-center/rules";
import { cn } from "@/lib/cn";
import { addDays, formatDate, formatDateTime, isIsoDate } from "@/lib/dates";
import { formatTime } from "@/lib/orders/schedule";
import { can, type Permission } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { ACTIVITY_PAGE_SIZE, QUEUE_PAGE_SIZE, loadActivity, loadAssigneeOptions, loadLayout, loadQueue, loadSummary } from "@/server/data/command-center";
import { listCustomerOptions } from "@/server/data/customers";
import { loadQuoteDashboard } from "@/server/data/dashboard";
import { loadDriverHome } from "@/server/data/driver";
import { fleetOverview } from "@/server/data/fleet";
import { getUserNames } from "@/server/data/quotes";
import { businessToday, getSettings } from "@/server/data/settings";

export const metadata = { title: "Command Center" };

type Search = { kind?: string; mine?: string; hidden?: string; page?: string; activity?: string; from?: string; to?: string; customer?: string; welcome?: string };

/** Permissions that give a person operational responsibilities shown here (the database checks them again). */
const OPERATIONS: Permission[] = ["dispatch.view", "tickets.view", "billing.view", "fleet.view", "field_reports.view", "orders.view"];
const OFFICE: Permission[] = [...OPERATIONS, "quotes.view"];

const positive = (v: string | undefined, max = 500) => {
  const n = Number.parseInt(v ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 1;
};

function activityHref(e: { entity_type: string; entity_id: string | null }) {
  if (!e.entity_id) return null;
  switch (e.entity_type) {
    case "order": return `/orders/${e.entity_id}`;
    case "quote": return `/quotes/${e.entity_id}`;
    case "customer": return `/customers/${e.entity_id}`;
    case "truck": return `/fleet/trucks/${e.entity_id}`;
    case "trailer": return `/fleet/trailers/${e.entity_id}`;
    case "driver": return `/fleet/drivers/${e.entity_id}`;
    default: return null;
  }
}

export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requireAccess();
  const has = (p: Permission) => can(access, p);
  // People whose only responsibility is driving start on their own day.
  if (has("driver.portal") && !OFFICE.some(has)) redirect("/driver");
  const sp = await searchParams;
  const ops = OPERATIONS.some(has);
  const kind = sp.kind && (EXCEPTION_KINDS as readonly string[]).includes(sp.kind) ? (sp.kind as ExceptionKind) : undefined;
  const mine = sp.mine === "1";
  const hidden = sp.hidden === "1";
  const page = positive(sp.page);
  const activityPage = positive(sp.activity, 20);
  const canAssign = has("exceptions.assign");
  const [{ today, timezone }, settings] = await Promise.all([businessToday(), getSettings()]);
  const from = sp.from && isIsoDate(sp.from) ? sp.from : addDays(today, -30);
  const to = sp.to && isIsoDate(sp.to) ? sp.to : today;
  const customer = sp.customer && /^[0-9a-f-]{36}$/i.test(sp.customer) ? sp.customer : undefined;

  const none = Promise.resolve(null);
  const [summary, queue, mineTop, activity, people, names, layout, quotes, customers, fleet, driver] = await Promise.all([
    ops ? loadSummary() : none,
    ops ? loadQueue({ kind, mine, page, hidden }) : none,
    ops ? loadQueue({ mine: true, page: 1, limit: 5 }) : none,
    loadActivity(access, activityPage),
    canAssign ? loadAssigneeOptions() : Promise.resolve([]),
    getUserNames(),
    loadLayout(),
    has("quotes.view") ? loadQuoteDashboard({ from, to, customer }, today, settings.quote_followup_days).catch(() => null) : none,
    has("quotes.view") ? listCustomerOptions() : Promise.resolve([]),
    has("fleet.view") ? fleetOverview().catch(() => null) : none,
    has("driver.portal") ? loadDriverHome() : none,
  ]);
  const now = new Date();

  // The URL of exactly this view: records opened from here return to it.
  const href = (p: { kind?: ExceptionKind; mine?: boolean; hidden?: boolean; page?: number; activity?: number }, anchor = "#attention") => {
    const q = new URLSearchParams();
    if (p.kind) q.set("kind", p.kind);
    if (p.mine) q.set("mine", "1");
    if (p.hidden) q.set("hidden", "1");
    if (p.page && p.page > 1) q.set("page", String(p.page));
    if (p.activity && p.activity > 1) q.set("activity", String(p.activity));
    if (sp.from) q.set("from", from);
    if (sp.to) q.set("to", to);
    if (customer) q.set("customer", customer);
    const s = q.toString();
    return `/command-center${s ? `?${s}` : ""}${anchor}`;
  };
  const back = href({ kind, mine, hidden, page });
  const cardCan = { ticketsEdit: has("tickets.edit"), dispatch: has("dispatch.view"), assign: canAssign };
  const s = summary?.ok ? summary.data : null;
  const linkedDriver = driver?.ok ? driver.data : null;

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------
  const sections: Section[] = [];

  // Your work: what is assigned to you, and your own loads when you also drive.
  if (ops || linkedDriver) {
    const myItems = mineTop?.ok ? mineTop.data : null;
    const myLoads = linkedDriver?.assignments.filter((a) => a.load.date === today) ?? [];
    sections.push({
      id: "my_work",
      title: "Your work",
      collapsedSummary: [myItems?.total ? `${myItems.total} assigned to you` : null, linkedDriver ? `${myLoads.length} of your loads today` : null].filter(Boolean).join(" · ") || undefined,
      content: (
        <div className={cn("grid grid-cols-1 gap-5", linkedDriver && ops && "xl:grid-cols-2")}>
          {ops && (
            <Card>
              <CardHeader title="Assigned to you" description="Items someone asked you to handle. They close when the record is fixed." />
              {!myItems ? (
                <div className="p-4"><ErrorState title="Your items could not be loaded" description="This does not mean nothing is assigned to you. Try again in a moment." /></div>
              ) : myItems.items.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted sm:px-5">Nothing is assigned to you right now.</p>
              ) : (
                <>
                  <ul className="divide-y divide-line" aria-label="Assigned to you">
                    {myItems.items.map((item) => (
                      <ExceptionCard key={item.exception_key} item={item} can={cardCan} people={people} timezone={timezone} now={now} back={back} />
                    ))}
                  </ul>
                  {myItems.total > myItems.items.length && (
                    <p className="px-4 py-3 text-sm sm:px-5"><Link href={href({ mine: true })} className="font-semibold underline">All {myItems.total} assigned to you</Link></p>
                  )}
                </>
              )}
            </Card>
          )}
          {linkedDriver && (
            <Card>
              <CardHeader
                title="Your loads today"
                description="Because your account is linked to a driver record. Tickets and reports go through My Day."
                actions={<ButtonLink href="/driver" size="sm" variant="secondary" icon={<Route className="size-4" />}>Open My Day</ButtonLink>}
              />
              {myLoads.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted sm:px-5">No loads assigned to you today.</p>
              ) : (
                <ul className="divide-y divide-line" aria-label="Your loads today">
                  {myLoads.map((a) => (
                    <li key={a.assignment_id} className="px-4 py-3 text-sm sm:px-5">
                      <p className="font-semibold">{formatTime(a.load.start_time)} – {formatTime(a.load.end_time)} · {a.order.number} load {a.load.number}</p>
                      <p className="text-muted">{a.order.customer_name} · {a.site.label || a.site.line1} · Truck {a.truck ?? "—"}{a.trailer ? ` + ${a.trailer}` : ""}</p>
                      {a.tickets.length === 0 && a.can_submit_ticket && <Link href={`/driver/assignments/${a.assignment_id}/ticket`} className="font-semibold text-brand-fg hover:underline">Send the ticket</Link>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      ),
    });
  }

  if (ops) {
    const visibleKinds = s ? EXCEPTION_KINDS.filter((k) => (s.by_kind[k] ?? 0) > 0 || kind === k) : [];
    sections.push({
      id: "attention",
      title: "Attention queue",
      collapsedSummary: s ? `${s.exceptions.total} open · ${s.exceptions.urgent} urgent` : "Could not be loaded",
      content: (
        <Card>
          <CardHeader title="What needs attention" description="One item per underlying problem, most urgent and oldest first. An item leaves the queue only when its record is fixed in its own module." />
          <nav aria-label="Filter the queue" className="flex flex-wrap gap-2 border-b border-line px-4 py-3 sm:px-5">
            <Chip href={href({})} active={!kind && !mine && !hidden} label="All" count={queue?.ok && !kind && !mine && !hidden ? queue.data.total : s ? s.exceptions.total - (s.exceptions.hidden ?? 0) : undefined} />
            {visibleKinds.map((k) => (
              <Chip key={k} href={href({ kind: k })} active={kind === k && !mine && !hidden} label={KIND_LABELS[k]} count={s?.by_kind[k] ?? 0} />
            ))}
            {s && s.exceptions.mine > 0 && <Chip href={href({ mine: true })} active={mine && !hidden} label="Assigned to me" count={s.exceptions.mine} />}
            {s && (s.exceptions.hidden ?? 0) > 0 && <Chip href={href({ hidden: true })} active={hidden} label="Hidden by you" count={s.exceptions.hidden} />}
          </nav>
          <details className="border-b border-line px-4 py-2 text-sm sm:px-5">
            <summary className="cursor-pointer font-semibold text-muted">How priority is decided</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              {PRIORITY_RULES.map((r) => <li key={r}>{r}</li>)}
              <li>Within a priority, the oldest problem comes first. Age is shown only when it is known from the record.</li>
              <li>Hiding an item only removes it from your own view for a while; urgent items cannot be hidden.</li>
            </ul>
          </details>
          {!queue?.ok ? (
            <div className="p-4 sm:p-5">
              <ErrorState title="The attention queue could not be loaded" description="This does not mean nothing needs attention. Open the modules directly or try again." action={<Link href={back} className={buttonClasses("secondary")}>Try again</Link>} />
            </div>
          ) : queue.data.items.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="size-6" />}
              title={hidden ? "Nothing hidden" : kind || mine ? "Nothing in this view" : "Nothing needs attention"}
              description={
                hidden ? "Items you hide come back here until they reappear in the queue."
                : kind || mine ? "Choose “All” to see every open item."
                : `No open items you can see${queue.data.hidden ? ` (${queue.data.hidden} hidden by you)` : ""}. Checked: urgent orders, loads today without a truck, assignment problems, missing tickets, tickets to review, billing blocks, equipment out of service and driver reports.`
              }
            />
          ) : (
            <>
              {hidden && <p className="border-b border-line bg-surface px-4 py-2 text-sm sm:px-5">These are still open for everyone else. They return to your queue when the time runs out.</p>}
              <ul className="divide-y divide-line" aria-label="Attention items">
                {queue.data.items.map((item) => (
                  <ExceptionCard key={item.exception_key} item={item} can={cardCan} people={people} timezone={timezone} now={now} back={back} />
                ))}
              </ul>
              <Pagination page={page} pageSize={QUEUE_PAGE_SIZE} total={queue.data.total} hrefFor={(p) => href({ kind, mine, hidden, page: p })} />
            </>
          )}
        </Card>
      ),
    });

    const cards: MetricCard[] = s ? metricCards(s) : [];
    if (fleet) {
      cards.push({
        key: "drivers_ready",
        label: "Drivers ready today",
        value: fleet.drivers.ready,
        sub: `${fleet.drivers.notReady.length} not eligible (qualifications)`,
        href: "/fleet/drivers",
        tone: fleet.drivers.notReady.length > 0 ? "warn" : "default",
      });
    }
    sections.push({
      id: "operations",
      title: "Operations today",
      content: summary?.ok ? (
        <MetricGrid cards={cards} />
      ) : (
        <ErrorState title="The overview could not be loaded" description="No figures are shown rather than guessed. Try again in a moment." action={<Link href={back} className={buttonClasses("secondary")}>Try again</Link>} />
      ),
    });
  }

  if (has("quotes.view")) {
    sections.push({
      id: "sales",
      title: "Sales and quotes",
      content: quotes ? (
        <SalesSection quotes={quotes} from={from} to={to} customer={customer} customers={customers} followupDays={settings.quote_followup_days} today={today} resetHref="/command-center" />
      ) : (
        <ErrorState title="Quote figures could not be loaded" description="Open Quotes directly or try again." />
      ),
    });
  }

  sections.push({
    id: "activity",
    title: "Recent activity",
    content: (
      <Card>
        <CardHeader title="What changed" description={has("audit.view") ? "Everything recorded in this company's audit log." : "Orders, quotes, dispatch, tickets and fleet, as your role allows."} />
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
              {activityPage > 1 ? <Link href={href({ kind, mine, hidden, page, activity: activityPage - 1 }, "#section-activity")} className={buttonClasses("secondary", "sm")}>Newer</Link> : <span />}
              {activity.data.hasMore && <Link href={href({ kind, mine, hidden, page, activity: activityPage + 1 }, "#section-activity")} className={buttonClasses("secondary", "sm")}>Older</Link>}
            </div>
            <p className="px-4 pb-3 text-xs text-muted sm:px-5">{ACTIVITY_PAGE_SIZE} per page.</p>
          </>
        )}
      </Card>
    ),
  });

  return (
    <>
      <PageHeader
        title="Command Center"
        description={`Good to see you${access.fullName ? `, ${access.fullName.split(" ")[0]}` : ""}. Today is ${formatDate(today)}. What needs attention, what is yours, and where to fix it — read live from the records.`}
        actions={
          <>
            <RefreshButton />
            {has("quotes.edit") && <ButtonLink href="/quotes/new" icon={<Plus className="size-4" />}>New quote</ButtonLink>}
          </>
        }
      />

      {sp.welcome === "1" && (
        <div className="mb-5">
          <Notice title={`${access.companyName ?? "Your company"} is ready`}>
            Next: check <Link href="/settings" className="font-semibold underline">Settings → Company</Link> (address, time zone, numbering), invite your team in Settings → Users, then add trucks and drivers in Fleet. Nothing from any other company was copied in.
          </Notice>
        </div>
      )}

      {/* Pinned status strip: not movable, not collapsible, urgent counts always visible. */}
      {ops &&
        (s ? (
          <section aria-label="Attention summary" className={cn("mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line border-l-4 bg-card px-4 py-3 shadow-xs sm:px-5", s.exceptions.urgent > 0 ? "border-l-critical" : s.exceptions.total > 0 ? "border-l-amber-400" : "border-l-green-500")}>
            <p className="text-base font-semibold text-ink">
              {s.exceptions.total === 0 ? "Nothing needs attention" : `${s.exceptions.total} item${s.exceptions.total === 1 ? "" : "s"} need attention`}
            </p>
            {s.exceptions.urgent > 0 && (
              <Link href={href({})} className="rounded bg-critical px-2 py-0.5 text-sm font-semibold text-white">{s.exceptions.urgent} urgent</Link>
            )}
            {(s.urgent_orders ?? 0) > 0 && (
              <Link href={href({ kind: "urgent_order" })} className="text-sm font-semibold text-critical underline-offset-2 hover:underline">{s.urgent_orders} urgent order{s.urgent_orders === 1 ? "" : "s"}</Link>
            )}
            {s.exceptions.mine > 0 && <Link href={href({ mine: true })} className="text-sm font-semibold text-brand-fg underline-offset-2 hover:underline">{s.exceptions.mine} assigned to you</Link>}
            {(s.exceptions.hidden ?? 0) > 0 && <Link href={href({ hidden: true })} className="text-sm text-muted underline-offset-2 hover:underline">{s.exceptions.hidden} hidden by you</Link>}
            <p className="ml-auto text-xs text-muted">As of {formatDateTime(s.as_of, timezone)}</p>
          </section>
        ) : (
          <div className="mb-5">
            <ErrorState title="Priorities could not be loaded" description="This does not mean nothing needs attention. Open Dispatch, Delivery Tickets and Billing directly, or try again." action={<Link href={back} className={buttonClasses("secondary")}>Try again</Link>} />
          </div>
        ))}

      {!ops && !has("quotes.view") && !linkedDriver ? (
        <EmptyState title="Nothing to coordinate for your role yet" description="Your role does not include orders, dispatch, tickets, billing, fleet or quotes. Use the menu for the modules you can open." />
      ) : (
        <SectionLayout sections={sections} initial={layout} />
      )}
    </>
  );
}

function Chip({ href, active, label, count }: { href: string; active: boolean; label: string; count?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors", active ? "border-strong bg-strong text-white" : "border-line bg-card text-ink hover:border-strong/30")}
    >
      {label}
      {count !== undefined && <Badge tone={active ? "dark" : count > 0 ? "amber" : "gray"}>{count}</Badge>}
    </Link>
  );
}

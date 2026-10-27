import Link from "next/link";
import { DispatchBoard } from "@/components/dispatch/dispatch-board";
import { DispatchTimeline } from "@/components/dispatch/dispatch-timeline";
import { RouteViews, type RouteView } from "@/components/routing/route-views";
import { UrgentOrders } from "@/components/dispatch/urgent-orders";
import { NeedsScheduling } from "@/components/dispatch/needs-scheduling";
import { SmartDispatch } from "@/components/dispatch/smart-dispatch";
import { getSmartDispatchPlan } from "@/server/data/smart-dispatch";
import { ReturnLink } from "@/components/ui/return-link";
import { ButtonLink } from "@/components/ui/button";
import { CalendarRange, GanttChart, MapPinned, Route, Sparkles, Truck, Users } from "lucide-react";
import { createClient } from "@/server/supabase/server";
import { cn } from "@/lib/cn";
import { listOpenUrgencies } from "@/server/data/urgency";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateLong, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getDispatchDay, listUnscheduledOrders } from "@/server/data/dispatch";
import { facesForDrivers } from "@/server/data/faces";
import { baseOptions, parseBaseFilter } from "@/server/data/bases";
import { businessToday } from "@/server/data/settings";
import { loadTruckHealth } from "@/server/data/truck-health";
import { loadSiteWeather } from "@/server/weather";

export const metadata = { title: "Dispatch" };

// Dispatch and the Route Planner are one page (owner 2026-10-26): the board, the day as a timeline, each truck's
// route, planning a route and the saved locations. /route-planner redirects here.
const VIEWS = [
  { key: "board", label: "Board", icon: CalendarRange },
  { key: "timeline", label: "Timeline", icon: GanttChart },
  { key: "routes", label: "Routes", icon: Route },
  { key: "plan", label: "Plan a route", icon: Sparkles },
  { key: "locations", label: "Locations", icon: MapPinned },
] as const;
type View = (typeof VIEWS)[number]["key"];

function ViewTabs({ view, date }: { view: View; date: string }) {
  return (
    <nav aria-label="Dispatch views" className="mb-5 flex gap-1 overflow-x-auto rounded-panel border border-line/70 bg-card p-1 shadow-card sm:inline-flex">
      {VIEWS.map((v) => {
        const href = v.key === "board" ? `/dispatch?date=${date}` : v.key === "plan" || v.key === "locations" ? `/dispatch?view=${v.key}` : `/dispatch?view=${v.key}&date=${date}`;
        const Icon = v.icon;
        return (
          <Link key={v.key} href={href} aria-current={view === v.key ? "page" : undefined}
            className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-semibold", view === v.key ? "bg-strong text-white" : "text-muted hover:bg-surface hover:text-ink")}>
            <Icon className="size-4" aria-hidden /> {v.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default async function DispatchPage({ searchParams }: { searchParams: Promise<{ date?: string; load?: string; back?: string; horizon?: string; base?: string; view?: string; truck?: string; route?: string }> }) {
  const access = await requirePagePermission("dispatch.view");
  const sp = await searchParams;
  const { date: param, load, back, horizon: h, base: baseParam } = sp;
  const view: View = VIEWS.some((v) => v.key === sp.view) ? (sp.view as View) : "board";
  const { today, timezone } = await businessToday();
  const date = param && isIsoDate(param) ? param : today;
  // Hired trucks (B83) is an add-on: its link shows only where the platform owner switched it on.
  const hired = await (await createClient()).rpc("hired_trucks_enabled").then((r) => r.data === true, () => false);
  const header = (description: string) => (
    <>
      <ReturnLink back={back} />
      <PageHeader
        title="Dispatch"
        description={description}
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/dispatch/plan?back=${encodeURIComponent(`/dispatch?date=${date}`)}`} icon={<Sparkles className="size-4" />}>Plan the day</ButtonLink>
            <ButtonLink href={`/dispatch/resources?date=${date}`} variant="secondary" icon={<Users className="size-4" />}>Driver &amp; truck availability</ButtonLink>
            {hired && <ButtonLink href="/hired-trucks" variant="secondary" icon={<Truck className="size-4" />}>Hired trucks</ButtonLink>}
          </div>
        }
      />
      <ViewTabs view={view} date={date} />
    </>
  );

  if (view === "routes" || view === "plan" || view === "locations") {
    return (
      <>
        {header(view === "routes" ? "Each truck's day as a route, read from the board." : view === "plan" ? "Plan truck routes between your yards, quarries and job sites. Plans here never assign a load." : "The places your trucks use: yards, quarries, job sites.")}
        <RouteViews access={access} view={view as RouteView} sp={{ truck: sp.truck, route: sp.route }} date={date} />
      </>
    );
  }
  const horizon = [1, 3, 7].includes(Number(h)) ? Number(h) : 3;
  // The base filter applies only where the company has bases to choose from (and the bases update is installed).
  const bases = await baseOptions();
  const base = bases.length > 1 ? parseBaseFilter(baseParam) : null;
  const [day, urgent, unscheduled, smart, health, weather] = await Promise.all([
    getDispatchDay(date, base),
    listOpenUrgencies(),
    view === "board" ? listUnscheduledOrders() : Promise.resolve([]),
    view !== "board" ? Promise.resolve({ error: "" }) : getSmartDispatchPlan(today, horizon).catch((e: unknown) => {
      // Details go to the server log; the board shows a plain message (no table or query names).
      console.error("Smart Dispatch failed", e);
      return { error: "Smart Dispatch suggestions are unavailable right now. The board below still works; try again in a moment." };
    }),
    // Truck health (B93) beside each truck; never blocks, and left out if it cannot be read.
    view === "board" ? loadTruckHealth().catch(() => null) : Promise.resolve(null),
    // Weather at this day's job sites (B92); a demo reads a sample forecast (DEMO_TENANTS §2).
    view === "board" ? loadSiteWeather(today, Boolean(access.isDemo)).catch(() => null) : Promise.resolve(null),
  ]);
  // Faces for every driver on the board or in a proposal (larger fleets: put a face to a name).
  const faces = await facesForDrivers(day.drivers.map((d) => d.id));
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const description = `${weekday}, ${formatDateLong(date)}${date === today ? " — today" : ""}. Plan loads for scheduled orders and assign a truck, trailer and driver to each.`;

  if (view === "timeline") {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).formatToParts(new Date());
    const nowMinutes = date === today ? Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value) : null;
    return (
      <>
        {header(description)}
        {urgent !== null && <UrgentOrders items={urgent} canAcknowledge={can(access, "dispatch.edit")} timezone={timezone} back={`/dispatch?view=timeline&date=${date}`} now={new Date().toISOString()} />}
        <DispatchTimeline day={day} faces={faces} urgentOrderIds={urgent?.map((u) => u.order_id) ?? []} nowMinutes={nowMinutes} />
      </>
    );
  }

  return (
    <>
      {header(description)}
      {urgent === null ? (
        <p role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm">Urgent orders could not be loaded. Check the Command Center before planning.</p>
      ) : (
        <UrgentOrders items={urgent} canAcknowledge={can(access, "dispatch.edit")} timezone={timezone} back={`/dispatch?date=${date}`} now={new Date().toISOString()} />
      )}
      {unscheduled === null ? (
        <p role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm">Orders waiting for a delivery date could not be loaded.</p>
      ) : (
        <NeedsScheduling items={unscheduled} canSchedule={can(access, "orders.schedule")} today={today} back={`/dispatch?date=${date}`} />
      )}
      {"error" in smart ? (
        <p role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm">{smart.error}</p>
      ) : (
        <SmartDispatch plans={smart.plans} from={smart.from} to={smart.to} horizon={horizon} canEdit={can(access, "dispatch.edit")} timezone={timezone} back={`/dispatch?date=${date}`} faces={faces} />
      )}
      <div data-guide="dispatch-board">
        {(() => {
          const onDay = weather?.alerts.filter((a) => a.day === date) ?? [];
          return onDay.length ? (
            <section aria-label="Weather at job sites" className="mb-4 rounded-panel border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              <p className="font-semibold">Weather at job sites{weather?.sample ? " (sample forecast, demo)" : ""}</p>
              <ul className="mt-1 space-y-0.5">
                {onDay.map((a) => <li key={a.siteId}>{a.hazards.map((h) => h.label).join(" · ")} at {a.site} — {a.loads} load{a.loads === 1 ? "" : "s"} ({a.orders.join(", ")})</li>)}
              </ul>
            </section>
          ) : null;
        })()}
        <DispatchBoard day={day} health={Object.fromEntries((health?.rows ?? []).filter((r) => r.level !== "good").map((r) => [r.truck_id, { level: r.level as "watch" | "at_risk", reasons: r.reasons }]))} bases={bases} faces={faces} urgentOrderIds={urgent?.map((u) => u.order_id) ?? []} canEdit={can(access, "dispatch.edit")} canEnterTickets={can(access, "tickets.edit")} focusLoadId={load && /^[0-9a-f-]{36}$/i.test(load) ? load : null} />
      </div>
    </>
  );
}

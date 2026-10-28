import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarOff, CalendarX2, UserCheck } from "lucide-react";
import { DayTimeline } from "@/components/schedule/day-timeline";
import { ScheduleGrid } from "@/components/schedule/schedule-grid";
import { StaffingForecast } from "@/components/schedule/staffing-forecast";
import { StatTile } from "@/components/ui/stat-tile";
import { cn } from "@/lib/cn";
import { staffingForecast } from "@/lib/schedule/shifts";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { addDays, formatDate, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { facesForEmployees } from "@/server/data/faces";
import { getScheduleWeek, listPatterns, plannedLoadsByDay, weekStart } from "@/server/data/schedules";
import { businessToday } from "@/server/data/settings";
import { timeOffInRange } from "@/server/data/time-off";
import { listShiftOffers } from "@/server/data/shift-offers";
import { OfferShiftButton, ShiftOffersList } from "@/components/schedule/shift-offers";
import { Card, CardHeader } from "@/components/ui/card";

export const metadata = { title: "Schedule" };

/**
 * Shift schedules (migration 20261120003300): the week for everyone the person may see, with each day's shift, day off
 * or one-day change. Owner, office and dispatch (schedules.manage) change days and repeating patterns.
 */
export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string; q?: string; view?: string; day?: string }> }) {
  const access = await requireAccess();
  if (!can(access, "employees.view") && !can(access, "dispatch.view") && !can(access, "schedules.manage")) redirect("/no-access?missing=schedules.manage");
  const manage = can(access, "schedules.manage");
  const sp = await searchParams;
  const { today } = await businessToday();
  const from = weekStart(sp.week && isIsoDate(sp.week) ? sp.week : today);
  const to = addDays(from, 6);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  // Day view: one day of the shown week as a timeline (today when it is in the week, else the Monday).
  const dayView = sp.view === "day";
  const day = sp.day && isIsoDate(sp.day) && sp.day >= from && sp.day <= to ? sp.day : today >= from && today <= to ? today : from;
  const [week, patterns, timeOff, loadsByDay, offers] = await Promise.all([
    getScheduleWeek(from, 7), listPatterns(from), timeOffInRange(from, to).catch(() => null),
    can(access, "dispatch.view") ? plannedLoadsByDay(from, to).catch(() => null) : Promise.resolve(null),
    manage || can(access, "dispatch.view") ? listShiftOffers(today) : Promise.resolve(null),
  ]);
  const faces = await facesForEmployees(week.people.map((p) => p.employeeId));
  const q = (sp.q ?? "").trim().toLowerCase();
  const people = q ? week.people.filter((p) => p.name.toLowerCase().includes(q)) : week.people;
  const todayRows = week.people.map((p) => p.days.find((d) => d.date === today)).filter(Boolean);
  const forecast = staffingForecast(week.people, dates, loadsByDay);
  const inWeek = today >= from && today <= to;
  const link = (extra: Record<string, string>) => `/schedule?${new URLSearchParams({ week: from, ...(sp.q ? { q: sp.q } : {}), ...extra })}`;
  const counts = { on: todayRows.filter((d) => d!.status === "shift").length, off: todayRows.filter((d) => d!.status === "off").length, none: todayRows.filter((d) => d!.status === "none").length };

  return (
    <>
      <PageHeader title="Schedule" description="Who works when: repeating schedules, rotations and changes for one day. Dispatch checks these before assigning a driver." />
      {!week.installed ? (
        <Notice title="Not available yet">Schedules need a database update that has not been installed yet.</Notice>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <ButtonLink variant="secondary" size="sm" href={`/schedule?week=${addDays(from, -7)}`}>Previous week</ButtonLink>
            <ButtonLink variant="secondary" size="sm" href="/schedule">This week</ButtonLink>
            <ButtonLink variant="secondary" size="sm" href={`/schedule?week=${addDays(from, 7)}`}>Next week</ButtonLink>
            <span className="ml-1 text-sm font-semibold text-ink">Week of {formatDate(from)}</span>
            <form className="ml-auto" action="/schedule">
              <input type="hidden" name="week" value={from} />
              <label className="sr-only" htmlFor="schedule-q">Find a person</label>
              <input id="schedule-q" name="q" defaultValue={sp.q ?? ""} placeholder="Find a person…" className="h-9 rounded-control border border-line bg-card px-3 text-sm" />
            </form>
          </div>
          {inWeek && (
            <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Today">
              <StatTile icon={<UserCheck />} tone="brand" label="On shift today" value={counts.on} muted={counts.on === 0}><span className="sr-only">{counts.on} </span>people working today</StatTile>
              <StatTile icon={<CalendarOff />} label="Off today" value={counts.off} muted={counts.off === 0}><span className="sr-only">{counts.off} </span>scheduled days off</StatTile>
              <StatTile icon={<CalendarX2 />} tone={counts.none ? "amber" : "neutral"} label="Without a schedule" value={counts.none} muted={counts.none === 0}><span className="sr-only">{counts.none} </span>{counts.none ? "set a pattern or a day" : "everyone is scheduled"}</StatTile>
            </div>
          )}
          {forecast.some((d) => d.drivers || d.loads) ? <StaffingForecast days={forecast} today={today} /> : null}
          {offers?.installed && (manage || offers.offers.length > 0) && (
            <Card className="mb-5">
              <CardHeader
                title="Shift offers"
                description={offers.offers.length ? undefined : "Need someone extra on a day? Offer a shift; qualified people answer from My Day."}
                actions={manage ? <OfferShiftButton mode={offers.mode} today={today} people={week.people.map((p) => ({ id: p.employeeId, name: p.name, driver: !!p.driverId, shop: p.department === "shop" }))} /> : undefined}
              />
              {offers.offers.length > 0 && <ShiftOffersList offers={offers.offers} canManage={manage} names={Object.fromEntries(week.people.map((p) => [p.employeeId, p.name]))} />}
            </Card>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div role="group" aria-label="View" className="inline-flex rounded-control bg-surface p-0.5 ring-1 ring-line">
              <Link href={link({})} aria-current={!dayView ? "page" : undefined} className={cn("rounded-[calc(var(--radius-control)-2px)] px-3 py-1 text-sm font-medium", !dayView ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>Week</Link>
              <Link href={link({ view: "day", day })} aria-current={dayView ? "page" : undefined} className={cn("rounded-[calc(var(--radius-control)-2px)] px-3 py-1 text-sm font-medium", dayView ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>Day</Link>
            </div>
            {dayView && (
              <nav aria-label="Day" className="flex flex-wrap gap-1">
                {dates.map((d) => (
                  <Link key={d} href={link({ view: "day", day: d })} aria-current={d === day ? "date" : undefined} className={cn("rounded-full px-2.5 py-1 text-xs font-medium", d === day ? "bg-strong text-white" : "text-muted hover:bg-surface hover:text-ink")}>
                    {`${new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`))} ${Number(d.slice(8))}`}
                  </Link>
                ))}
              </nav>
            )}
          </div>
          {people.length && dayView ? (
            <DayTimeline people={people} date={day} faces={faces} />
          ) : people.length ? (
            <ScheduleGrid people={people} from={from} canManage={manage} patterns={patterns} faces={faces} today={today} timeOff={timeOff ?? []} />
          ) : (
            <EmptyState title={q ? "Nobody matches" : "No people yet"} description={q ? "Try another name." : "Add people under People; their schedules show here."} action={q ? <Link href={`/schedule?week=${from}`} className="underline">Show everyone</Link> : undefined} />
          )}
        </>
      )}
    </>
  );
}

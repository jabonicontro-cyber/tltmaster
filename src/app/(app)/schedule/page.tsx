import Link from "next/link";
import { redirect } from "next/navigation";
import { ScheduleGrid } from "@/components/schedule/schedule-grid";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { addDays, formatDate, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { facesForEmployees } from "@/server/data/faces";
import { getScheduleWeek, listPatterns, weekStart } from "@/server/data/schedules";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Schedule" };

/**
 * Shift schedules (migration 20261120003300): the week for everyone the person may see, with each day's shift, day off
 * or one-day change. Owner, office and dispatch (schedules.manage) change days and repeating patterns.
 */
export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string; q?: string }> }) {
  const access = await requireAccess();
  if (!can(access, "employees.view") && !can(access, "dispatch.view") && !can(access, "schedules.manage")) redirect("/no-access?missing=schedules.manage");
  const manage = can(access, "schedules.manage");
  const sp = await searchParams;
  const { today } = await businessToday();
  const from = weekStart(sp.week && isIsoDate(sp.week) ? sp.week : today);
  const [week, patterns] = await Promise.all([getScheduleWeek(from, 7), listPatterns(from)]);
  const faces = await facesForEmployees(week.people.map((p) => p.employeeId));
  const q = (sp.q ?? "").trim().toLowerCase();
  const people = q ? week.people.filter((p) => p.name.toLowerCase().includes(q)) : week.people;
  const todayRows = week.people.map((p) => p.days.find((d) => d.date === today)).filter(Boolean);
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
          {today >= from && today <= addDays(from, 6) && (
            <p className="mb-3 text-sm text-muted">Today: <strong className="text-ink">{counts.on}</strong> on shift · <strong className="text-ink">{counts.off}</strong> off · <strong className="text-ink">{counts.none}</strong> without a schedule</p>
          )}
          {people.length ? (
            <ScheduleGrid people={people} from={from} canManage={manage} patterns={patterns} faces={faces} />
          ) : (
            <EmptyState title={q ? "Nobody matches" : "No people yet"} description={q ? "Try another name." : "Add people under People; their schedules show here."} action={q ? <Link href={`/schedule?week=${from}`} className="underline">Show everyone</Link> : undefined} />
          )}
        </>
      )}
    </>
  );
}

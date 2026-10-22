import { DispatchBoard } from "@/components/dispatch/dispatch-board";
import { UrgentOrders } from "@/components/dispatch/urgent-orders";
import { NeedsScheduling } from "@/components/dispatch/needs-scheduling";
import { SmartDispatch } from "@/components/dispatch/smart-dispatch";
import { getSmartDispatchPlan } from "@/server/data/smart-dispatch";
import { ReturnLink } from "@/components/ui/return-link";
import { ButtonLink } from "@/components/ui/button";
import { Sparkles, Users } from "lucide-react";
import { listOpenUrgencies } from "@/server/data/urgency";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateLong, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getDispatchDay, listUnscheduledOrders } from "@/server/data/dispatch";
import { baseOptions, parseBaseFilter } from "@/server/data/bases";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Dispatch" };

export default async function DispatchPage({ searchParams }: { searchParams: Promise<{ date?: string; load?: string; back?: string; horizon?: string; base?: string }> }) {
  const access = await requirePagePermission("dispatch.view");
  const { date: param, load, back, horizon: h, base: baseParam } = await searchParams;
  const { today, timezone } = await businessToday();
  const date = param && isIsoDate(param) ? param : today;
  const horizon = [1, 3, 7].includes(Number(h)) ? Number(h) : 3;
  // The base filter applies only where the company has bases to choose from (and the bases update is installed).
  const bases = await baseOptions();
  const base = bases.length > 1 ? parseBaseFilter(baseParam) : null;
  const [day, urgent, unscheduled, smart] = await Promise.all([
    getDispatchDay(date, base),
    listOpenUrgencies(),
    listUnscheduledOrders(),
    getSmartDispatchPlan(today, horizon).catch((e: unknown) => {
      // Details go to the server log; the board shows a plain message (no table or query names).
      console.error("Smart Dispatch failed", e);
      return { error: "Smart Dispatch suggestions are unavailable right now. The board below still works; try again in a moment." };
    }),
  ]);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

  return (
    <>
      <ReturnLink back={back} />
      <PageHeader
        title="Dispatch"
        description={`${weekday}, ${formatDateLong(date)}${date === today ? " — today" : ""}. Plan loads for scheduled orders and assign a truck, trailer and driver to each.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/dispatch/plan?back=${encodeURIComponent(`/dispatch?date=${date}`)}`} icon={<Sparkles className="size-4" />}>Plan the day</ButtonLink>
            <ButtonLink href={`/dispatch/resources?date=${date}`} variant="secondary" icon={<Users className="size-4" />}>Driver &amp; truck availability</ButtonLink>
          </div>
        }
      />
      {urgent === null ? (
        <p role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">Urgent orders could not be loaded. Check the Command Center before planning.</p>
      ) : (
        <UrgentOrders items={urgent} canAcknowledge={can(access, "dispatch.edit")} timezone={timezone} back={`/dispatch?date=${date}`} now={new Date().toISOString()} />
      )}
      {unscheduled === null ? (
        <p role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">Orders waiting for a delivery date could not be loaded.</p>
      ) : (
        <NeedsScheduling items={unscheduled} canSchedule={can(access, "orders.schedule")} today={today} back={`/dispatch?date=${date}`} />
      )}
      {"error" in smart ? (
        <p role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">{smart.error}</p>
      ) : (
        <SmartDispatch plans={smart.plans} from={smart.from} to={smart.to} horizon={horizon} canEdit={can(access, "dispatch.edit")} timezone={timezone} back={`/dispatch?date=${date}`} />
      )}
      <div data-guide="dispatch-board">
        <DispatchBoard day={day} bases={bases} canEdit={can(access, "dispatch.edit")} canEnterTickets={can(access, "tickets.edit")} focusLoadId={load && /^[0-9a-f-]{36}$/i.test(load) ? load : null} />
      </div>
    </>
  );
}

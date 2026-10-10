import { DispatchBoard } from "@/components/dispatch/dispatch-board";
import { UrgentOrders } from "@/components/dispatch/urgent-orders";
import { ReturnLink } from "@/components/ui/return-link";
import { listOpenUrgencies } from "@/server/data/urgency";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateLong, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getDispatchDay } from "@/server/data/dispatch";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Dispatch" };

export default async function DispatchPage({ searchParams }: { searchParams: Promise<{ date?: string; load?: string; back?: string }> }) {
  const access = await requirePagePermission("dispatch.view");
  const { date: param, load, back } = await searchParams;
  const { today, timezone } = await businessToday();
  const date = param && isIsoDate(param) ? param : today;
  const [day, urgent] = await Promise.all([getDispatchDay(date), listOpenUrgencies()]);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

  return (
    <>
      <ReturnLink back={back} />
      <PageHeader
        title="Dispatch"
        description={`${weekday}, ${formatDateLong(date)}${date === today ? " — today" : ""}. Plan loads for scheduled orders and assign a truck, trailer and driver to each.`}
      />
      {urgent === null ? (
        <p role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">Urgent orders could not be loaded. Check the Command Center before planning.</p>
      ) : (
        <UrgentOrders items={urgent} canAcknowledge={can(access, "dispatch.edit")} timezone={timezone} back={`/dispatch?date=${date}`} now={new Date().toISOString()} />
      )}
      <DispatchBoard day={day} canEdit={can(access, "dispatch.edit")} canEnterTickets={can(access, "tickets.edit")} focusLoadId={load && /^[0-9a-f-]{36}$/i.test(load) ? load : null} />
    </>
  );
}

import { DispatchBoard } from "@/components/dispatch/dispatch-board";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateLong, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getDispatchDay } from "@/server/data/dispatch";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Dispatch" };

export default async function DispatchPage({ searchParams }: { searchParams: Promise<{ date?: string; load?: string }> }) {
  const access = await requirePagePermission("dispatch.view");
  const { date: param, load } = await searchParams;
  const { today } = await businessToday();
  const date = param && isIsoDate(param) ? param : today;
  const day = await getDispatchDay(date);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

  return (
    <>
      <PageHeader
        title="Dispatch"
        description={`${weekday}, ${formatDateLong(date)}${date === today ? " — today" : ""}. Plan loads for scheduled orders and assign a truck, trailer and driver to each.`}
      />
      <DispatchBoard day={day} canEdit={can(access, "dispatch.edit")} canEnterTickets={can(access, "tickets.edit")} focusLoadId={load && /^[0-9a-f-]{36}$/i.test(load) ? load : null} />
    </>
  );
}

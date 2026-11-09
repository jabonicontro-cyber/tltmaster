import Link from "next/link";
import { notFound } from "next/navigation";
import { DriverTicketForm } from "@/components/driver/driver-ticket-form";
import { buttonClasses } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { formatDate } from "@/lib/dates";
import { vocabulary } from "@/lib/industry";
import { getSettings } from "@/server/data/settings";
import { requirePagePermission } from "@/server/auth";
import { loadAssignmentForm } from "@/server/data/driver";
import { createClient } from "@/server/supabase/server";

export async function generateMetadata() {
  return { title: vocabulary((await getSettings().catch(() => null))?.industry).single };
}

/** Current local time in the business timezone, "HH:MM". */
function nowIn(timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date());
}

export default async function DriverTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("driver.portal");
  const { id } = await params;
  const form = await loadAssignmentForm(id);
  if (!form) notFound();
  if (!form.ok) {
    return (
      <div className="mx-auto max-w-xl">
        <ErrorState title="This load is not available" description={form.error} action={<Link href="/driver" className={buttonClasses("secondary", "md", "min-h-12")}>Back to My Day</Link>} />
      </div>
    );
  }
  const f = form.data;
  const words = vocabulary((await getSettings().catch(() => null))?.industry);
  // Truck-day job (UX11): tickets are trips. Empty before 20261120008600 is installed.
  const td = await (await createClient()).rpc("driver_truck_days");
  const perTrip = !td.error && ((td.data ?? []) as Array<{ load_id: string }>).some((t) => t.load_id === f.load.id);
  return (
    <div className="mx-auto max-w-xl px-0">
      <h1 className="text-2xl font-black">{words.single}</h1>
      <p className="mb-4 text-muted">{f.order.number} · load {f.load.number} · {formatDate(f.load.date)} · {f.order.customer_name}</p>
      {!f.can_submit_ticket ? (
        <ErrorState title="Not yet" description={`${words.single} entry opens on the day of the load.`} action={<Link href="/driver" className={buttonClasses("secondary", "md", "min-h-12")}>Back to My Day</Link>} />
      ) : (
        <DriverTicketForm
          assignmentId={f.assignment_id}
          loadDate={f.load.date}
          defaultTime={f.load.date === f.today ? nowIn(f.timezone) : ""}
          lines={f.lines}
          units={f.units}
          existing={f.tickets}
          perTrip={perTrip}
          planned={{ quantity: f.load.planned_quantity, unit: f.load.unit_code }}
          queue={{ userId: access.userId, label: `Ticket for ${f.order.number} load ${f.load.number}` }}
        />
      )}
    </div>
  );
}

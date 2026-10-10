import Link from "next/link";
import { notFound } from "next/navigation";
import { DriverTicketForm } from "@/components/driver/driver-ticket-form";
import { buttonClasses } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { formatDate } from "@/lib/dates";
import { requirePagePermission } from "@/server/auth";
import { loadAssignmentForm } from "@/server/data/driver";

export const metadata = { title: "Delivery ticket" };

/** Current local time in the business timezone, "HH:MM". */
function nowIn(timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date());
}

export default async function DriverTicketPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("driver.portal");
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
  return (
    <div className="mx-auto max-w-xl px-0">
      <h1 className="text-2xl font-black">Delivery ticket</h1>
      <p className="mb-4 text-muted">{f.order.number} · load {f.load.number} · {formatDate(f.load.date)} · {f.order.customer_name}</p>
      {!f.can_submit_ticket ? (
        <ErrorState title="Not yet" description="Ticket entry opens on the day of the load." action={<Link href="/driver" className={buttonClasses("secondary", "md", "min-h-12")}>Back to My Day</Link>} />
      ) : (
        <DriverTicketForm
          assignmentId={f.assignment_id}
          loadDate={f.load.date}
          defaultTime={f.load.date === f.today ? nowIn(f.timezone) : ""}
          lines={f.lines}
          units={f.units}
          existing={f.tickets}
        />
      )}
    </div>
  );
}

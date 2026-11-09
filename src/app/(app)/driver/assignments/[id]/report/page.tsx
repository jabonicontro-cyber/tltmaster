import Link from "next/link";
import { notFound } from "next/navigation";
import { FieldReportForm } from "@/components/driver/field-report-form";
import { buttonClasses } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { formatDate } from "@/lib/dates";
import { requirePagePermission } from "@/server/auth";
import { loadAssignmentForm } from "@/server/data/driver";
import { ticketRef } from "@/lib/driver/my-day";

export const metadata = { title: "Report a problem" };

export default async function DriverReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ticket?: string }> }) {
  await requirePagePermission("driver.portal");
  const { id } = await params;
  // "Something wrong? Tell the office" on a sent ticket: the ticket number is filled in, only if it is on this load.
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
  const asked = ticketRef((await searchParams).ticket);
  const ticket = asked && f.tickets.some((t) => t.number === asked) ? asked : null;
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-black">{ticket ? `Problem with ticket ${ticket}` : "Report a problem"}</h1>
      <p className="mb-4 text-muted">{f.order.number} · load {f.load.number} · {formatDate(f.load.date)}</p>
      <FieldReportForm assignmentId={f.assignment_id} truck={f.truck} trailer={f.trailer} ticket={ticket} />
    </div>
  );
}

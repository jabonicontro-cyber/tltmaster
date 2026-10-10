import { notFound, redirect } from "next/navigation";
import { TicketForm } from "@/components/tickets/ticket-form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { can } from "@/lib/permissions";
import { trimNumber } from "@/lib/fleet/labels";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { getLoadForTicket, getTicket } from "@/server/data/tickets";

export const metadata = { title: "Correct delivery ticket" };

export default async function CorrectTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("tickets.edit");
  const { id } = await params;
  const detail = await getTicket(id);
  if (!detail) notFound();
  const t = detail.ticket;
  if (t.status === "voided" || t.status === "superseded") redirect(`/tickets/${id}`);
  if (t.status === "accepted" && !can(access, "tickets.review")) redirect(`/tickets/${id}`);
  const [ctx, { timezone }] = await Promise.all([getLoadForTicket(t.load_id), businessToday()]);
  if (!ctx) notFound();
  // Delivery time as entered: local business time.
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t.delivered_at));
  const part = (type: string) => local.find((p) => p.type === type)?.value ?? "";

  return (
    <>
      <PageHeader
        title={`Correct ticket ${t.ticket_number}`}
        crumbs={[{ label: "Delivery Tickets", href: "/tickets" }, { label: t.ticket_number, href: `/tickets/${id}` }, { label: "Correct" }]}
        description={`${t.snapshot.order_number} load ${t.snapshot.load_number} · ${t.snapshot.customer_name}`}
      />
      <div className="mb-5">
        <Notice title={`Revision ${t.revision} stays on record`}>
          Saving creates revision {t.revision + 1} of {t.ticket_number}. The current figures ({trimNumber(t.quantity)} {t.unit_code}) remain visible in the history, and the
          corrected ticket is reviewed again.
        </Notice>
      </div>
      <TicketForm
        mode="correct"
        ticketId={t.id}
        loadId={t.load_id}
        orderId={t.order_id}
        initial={{
          orderLineId: t.order_line_id,
          deliveredDate: `${part("year")}-${part("month")}-${part("day")}`,
          deliveredTime: `${part("hour")}:${part("minute")}`,
          quantity: trimNumber(t.quantity),
          unitCode: t.unit_code,
          externalReference: t.external_reference,
          notes: t.notes,
          truckId: t.truck_id,
          trailerId: t.trailer_id ?? "",
          driverId: t.driver_id,
        }}
        lines={ctx.lines}
        units={ctx.units}
        trucks={ctx.trucks}
        trailers={ctx.trailers}
        drivers={ctx.drivers}
        assignment={ctx.assignment ? { truckId: ctx.assignment.truck_id, trailerId: ctx.assignment.trailer_id ?? "", driverId: ctx.assignment.driver_id } : null}
        cancelHref={`/tickets/${id}`}
      />
    </>
  );
}

import Link from "next/link";
import { ReturnLink } from "@/components/ui/return-link";
import { notFound } from "next/navigation";
import { TicketForm } from "@/components/tickets/ticket-form";
import { DescriptionList } from "@/components/ui/description-list";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { formatDate } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatTime } from "@/lib/orders/schedule";
import { uuid } from "@/lib/schemas/common";
import { requirePagePermission } from "@/server/auth";
import { getLoadForTicket } from "@/server/data/tickets";

export const metadata = { title: "Enter delivery ticket" };

export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ load?: string; back?: string }> }) {
  await requirePagePermission("tickets.edit");
  const { load: loadId, back } = await searchParams;
  if (!loadId || !uuid.safeParse(loadId).success) notFound();
  const ctx = await getLoadForTicket(loadId);
  if (!ctx) notFound();
  const { load, order, assignment, lines, existing } = ctx;
  const crumbs = [{ label: "Delivery Tickets", href: "/tickets" }, { label: "Enter ticket" }];

  return (
    <>
      <ReturnLink back={back} />
      <PageHeader title={`Ticket for ${order.order_number} load ${load.load_number}`} crumbs={crumbs} description={`${order.customer_name}${order.project_name ? ` · ${order.project_name}` : ""}`} />
      <Card className="mb-5">
        <CardBody>
          <DescriptionList
            items={[
              { label: "Planned", value: `${formatDate(load.load_date)}, ${formatTime(load.start_time)} – ${formatTime(load.end_time)}` },
              { label: "Planned quantity", value: load.planned_quantity !== null ? `${trimNumber(load.planned_quantity)} ${load.unit_code} (plan only)` : "Not planned" },
              { label: "Job site", value: [order.site_label || order.site_line1, order.site_city].filter(Boolean).join(", ") },
              { label: "Order", value: <Link href={`/orders/${order.id}`} className="underline">{order.order_number}</Link> },
            ]}
          />
        </CardBody>
      </Card>
      {!assignment ? (
        <Notice tone="warning" title="No truck and driver assigned">
          Assign this load on the <Link href={`/dispatch?date=${load.load_date}`} className="underline">dispatch board</Link> before entering its ticket.
        </Notice>
      ) : load.status === "canceled" ? (
        <Notice tone="warning" title="Load canceled">Tickets can only be entered for planned loads.</Notice>
      ) : (
        <>
          {existing.length > 0 && (
            <div className="mb-5">
              <Notice tone="warning" title="This load already has a ticket">
                {existing.map((t) => (
                  <Link key={t.id} href={`/tickets/${t.id}`} className="mr-2 font-semibold underline">{t.ticket_number}</Link>
                ))}
                — enter another only for a separate delivery (for example a split load). You will be asked to confirm.
              </Notice>
            </div>
          )}
          <TicketForm
            mode="new"
            loadId={load.id}
            orderId={order.id}
            initial={{
              orderLineId: lines.length === 1 ? lines[0].id : "",
              deliveredDate: load.load_date,
              deliveredTime: "",
              quantity: "",
              unitCode: "",
              externalReference: "",
              notes: "",
              truckId: assignment.truck_id,
              trailerId: assignment.trailer_id ?? "",
              driverId: assignment.driver_id,
            }}
            lines={lines}
            units={ctx.units}
            trucks={ctx.trucks}
            trailers={ctx.trailers}
            drivers={ctx.drivers}
            assignment={{ truckId: assignment.truck_id, trailerId: assignment.trailer_id ?? "", driverId: assignment.driver_id }}
            cancelHref="/tickets"
          />
        </>
      )}
    </>
  );
}

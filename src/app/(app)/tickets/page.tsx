import { PlannedModule } from "@/components/layout/planned-module";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Delivery Tickets" };

export default async function TicketsPage() {
  await requireAccess();
  return (
    <PlannedModule
      title="Delivery Tickets"
      phase="Phase 3 — Orders and tickets"
      summary="Printable driver tickets and delivery reconciliation."
      features={[
        "Numbered tickets with order, customer, site, material, planned quantity, truck and driver",
        "Print one ticket or a batch in dispatch order; full-page and half-page layouts; PDF copies",
        "Reprints and revisions clearly marked",
        "Record actual quantities, delivery times, notes and signatures — planned and actual both kept",
        "Review queues: awaiting data, awaiting review, missing information, ready for billing",
      ]}
      dependsOn="Orders and Dispatch."
    />
  );
}

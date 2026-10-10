import { PlannedModule } from "@/components/layout/planned-module";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Orders" };

export default async function OrdersPage() {
  await requireAccess();
  return (
    <PlannedModule
      title="Orders"
      phase="Phase 3 — Orders and tickets"
      summary="Jobs the business has committed to, created from accepted quotes or entered directly."
      features={[
        "Convert an accepted quote into an order with one click (safe to repeat — never creates duplicates)",
        "Direct orders for work that did not start with a quote",
        "Multiple delivery dates, loads and tickets per order",
        "Statuses: Draft, Confirmed, Scheduled, Dispatched, In Progress, Partially Completed, Completed, On Hold, Canceled",
        "Change history; operational edits never rewrite the accepted quote",
      ]}
      dependsOn="Quotes (available now). Accepted quotes are already recorded with the exact version the customer accepted."
    />
  );
}

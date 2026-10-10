import { PlannedModule } from "@/components/layout/planned-module";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  await requireAccess();
  return (
    <PlannedModule
      title="Reports"
      phase="Phase 5 — Reconciliation and reporting"
      summary="Operational reporting and billing exports."
      features={[
        "Quote conversion, volume by material and customer, deliveries by truck and driver",
        "Export of approved billing records for QuickBooks (safe to repeat — no duplicate invoices)",
        "Direct QuickBooks integration after confirming Desktop vs Online and the supported integration method",
      ]}
      dependsOn="Orders, tickets and reconciliation."
    />
  );
}

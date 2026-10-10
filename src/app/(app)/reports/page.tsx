import { PlannedModule } from "@/components/layout/planned-module";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  await requireAccess();
  return (
    <PlannedModule
      title="Reports"
      phase="Phase 5 — Reconciliation and reporting"
      summary="Operational reporting. Billing readiness and handoff files are under Billing."
      features={[
        "Quote conversion, volume by material and customer, deliveries by truck and driver",
        "Direct QuickBooks integration after confirming Desktop vs Online and the supported integration method",
      ]}
      dependsOn="Orders, tickets and billing readiness."
    />
  );
}

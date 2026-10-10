import { PlannedModule } from "@/components/layout/planned-module";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Dispatch" };

export default async function DispatchPage() {
  await requireAccess();
  return (
    <PlannedModule
      title="Dispatch"
      phase="Phase 3–4"
      summary="Day and week board for assigning trucks and drivers to orders."
      features={[
        "Day / week views with date navigation, search and filters",
        "Orders needing a truck or driver, scheduled work, time windows and job instructions",
        "Create, edit and remove assignments — with keyboard-accessible alternatives to drag-and-drop",
        "Conflict detection: double-booked trucks or drivers, unavailable equipment",
        "Several assignments and tickets per order",
      ]}
      dependsOn="Orders and Fleet."
    />
  );
}

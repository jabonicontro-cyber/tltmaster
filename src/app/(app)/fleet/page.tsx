import { PlannedModule } from "@/components/layout/planned-module";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Fleet" };

export default async function FleetPage() {
  await requireAccess();
  return (
    <PlannedModule
      title="Fleet"
      phase="Phase 4"
      summary="Trucks and drivers."
      features={[
        "Trucks: unit number, category (semi, quad-axle dump, …), axle configuration, verified payload, restrictions, availability",
        "Drivers: availability, qualifications and restrictions, optional contact information",
        "A truck is only treated as suitable for a delivery when its capacity and restrictions are entered and verified",
      ]}
      dependsOn="Real truck specifications from the business — capacities and restrictions are never assumed."
    />
  );
}

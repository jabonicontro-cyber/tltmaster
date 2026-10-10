import { PlannedModule } from "@/components/layout/planned-module";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Route Planner" };

export default async function RoutePlannerPage() {
  await requireAccess();
  return (
    <PlannedModule
      title="Route Planner"
      phase="Phase 4 — Dispatch and routing"
      summary="Map-based planning of deliveries and pickup locations, with AI assistance later."
      features={[
        "Map of delivery sites, quarries and suppliers",
        "Manual stop sequencing first; commercial-truck routing once a provider is selected",
        "Respect truck capacity, vehicle restrictions, delivery windows and driver availability",
        "Lock trucks, drivers or stops so optimization does not overwrite manual decisions",
        "AI-assisted planning that explains its recommendations — always reviewed by a dispatcher before anything is dispatched",
      ]}
      dependsOn={
        <>
          A routing provider that supports heavy-truck routing (vehicle dimensions and weight restrictions) must be evaluated and
          approved first. No routes, travel times or distances will be shown until real routing data is available.
        </>
      }
    />
  );
}

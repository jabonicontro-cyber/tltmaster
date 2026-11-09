import Link from "next/link";

/**
 * Where recorded hours of service are, for the hours confirmation before assigning (Fleet → Locations and hours). Shown
 * only to people who may open that page (fleet.view); Taviron still does not verify the hours.
 */
export function HoursLink({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="text-sm text-muted">
      Recorded hours are on{" "}
      <Link href="/fleet/locations" target="_blank" className="font-semibold text-brand-fg underline">Fleet → Locations and hours</Link>{" "}
      (opens in a new tab).
    </p>
  );
}

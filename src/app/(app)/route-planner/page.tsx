import { redirect } from "next/navigation";

// The Route Planner moved into Dispatch (owner 2026-10-26: one page for the board and the routes). Old links and
// bookmarks land on the matching Dispatch view.
export default async function RoutePlannerPage({ searchParams }: { searchParams: Promise<{ date?: string; truck?: string; view?: string; route?: string }> }) {
  const sp = await searchParams;
  const view = sp.view === "plan" || sp.view === "locations" ? sp.view : "routes";
  const q = new URLSearchParams({ view });
  for (const k of ["date", "truck", "route"] as const) if (sp[k]) q.set(k, sp[k]!);
  redirect(`/dispatch?${q.toString()}`);
}

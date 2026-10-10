import { redirect } from "next/navigation";

// The dashboard and the Command Center are one page now. Old links and
// bookmarks (including their filters) land on the Command Center.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && ["from", "to", "customer", "welcome"].includes(k)) q.set(k, v);
  }
  const s = q.toString();
  redirect(`/command-center${s ? `?${s}` : ""}`);
}

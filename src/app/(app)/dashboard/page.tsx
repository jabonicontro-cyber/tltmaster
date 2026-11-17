import { redirect } from "next/navigation";
import { signInHome } from "@/lib/companion";
import { requireAccess } from "@/server/auth";

// The dashboard and the Command Center are one page now. Old links and
// bookmarks (including their filters) land on the Command Center.
// `/dashboard` is also where the installed app and "Try again" open: a mechanic-only login goes to My jobs from here,
// as after signing in (walkthrough P13); the Command Center itself sends drivers to My Day.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requireAccess();
  const home = signInHome(access.permissions);
  if (home) redirect(home);
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && ["from", "to", "customer", "welcome"].includes(k)) q.set(k, v);
  }
  const s = q.toString();
  redirect(`/command-center${s ? `?${s}` : ""}`);
}

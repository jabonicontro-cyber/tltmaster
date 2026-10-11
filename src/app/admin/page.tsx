import Link from "next/link";
import { AppWindow, Building2, Inbox, PlayCircle, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Launchpad" };

interface Overview {
  new_leads: number;
  due_follow_ups: number;
  open_leads: number;
  companies: number;
  imports_in_review: number;
  demo_company: { id: string; name: string; created_at: string } | null;
}

export default async function LaunchpadPage() {
  const supabase = await createClient();
  const { data } = await supabase.rpc("platform_overview");
  const o = (data ?? {}) as Partial<Overview>;
  const tiles = [
    { href: "/admin/leads", icon: Inbox, title: "Leads", text: "Demo requests and messages from the website.", stat: `${o.new_leads ?? 0} new · ${o.due_follow_ups ?? 0} follow-ups due` },
    { href: "/admin/demo", icon: PlayCircle, title: "Live demo", text: "A separate demo company with fictional data and role previews.", stat: o.demo_company ? "Demo company ready" : "No demo yet" },
    { href: "/admin/onboarding", icon: Building2, title: "Company onboarding", text: "Create a customer company and import its records with review.", stat: `${o.companies ?? 0} companies · ${o.imports_in_review ?? 0} imports in review` },
    { href: "/command-center", icon: AppWindow, title: "The app", text: "Open Taviron in your own company (if you have one).", stat: "" },
    { href: "/admin/platform", icon: ShieldCheck, title: "Platform administration", text: "The platform team and the audit log of sensitive actions.", stat: "" },
  ];
  return (
    <>
      <PageHeader title="Launchpad" description="The Taviron team's tools. Everything here is checked against the platform role on the server and in the database." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="group rounded-lg border border-line bg-card p-5 shadow-xs hover:border-strong/40 hover:shadow-sm">
            <t.icon className="size-6 text-brand-fg" aria-hidden />
            <h2 className="mt-3 text-lg font-bold group-hover:underline">{t.title}</h2>
            <p className="mt-1 text-sm text-muted">{t.text}</p>
            {t.stat ? <p className="mt-3 text-sm font-semibold text-ink">{t.stat}</p> : null}
          </Link>
        ))}
      </div>
    </>
  );
}

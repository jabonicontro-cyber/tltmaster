import Link from "next/link";
import { cn } from "@/lib/cn";
import { can } from "@/lib/permissions";
import { getAccess } from "@/server/auth";

const TABS = [
  { key: "overview", label: "Overview", href: "/maintenance" },
  { key: "my-jobs", label: "My jobs", href: "/maintenance/my-jobs" },
  { key: "work-orders", label: "Work orders", href: "/maintenance/work-orders" },
  { key: "clearance", label: "Clearance queue", href: "/maintenance/clearance" },
  { key: "preventive", label: "Preventive", href: "/maintenance/preventive" },
  { key: "shop", label: "Shop capacity", href: "/maintenance/shop" },
  // Estimate against actual per job, kind of job and mechanic (B91): people with cost access (owner, office).
  { key: "estimates", label: "Time estimates", href: "/maintenance/estimates", permission: "maintenance.costs" },
] as const;

export async function MaintenanceTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  const access = await getAccess();
  const tabs = TABS.filter((t) => !("permission" in t) || (access && can(access, t.permission)));
  return (
    <nav aria-label="Maintenance sections" className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-150",
            t.key === active ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          <span className="pill-text">{t.label}</span>
        </Link>
      ))}
    </nav>
  );
}

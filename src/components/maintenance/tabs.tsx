import Link from "next/link";
import { cn } from "@/lib/cn";

const TABS = [
  { key: "overview", label: "Overview", href: "/maintenance" },
  { key: "my-jobs", label: "My jobs", href: "/maintenance/my-jobs" },
  { key: "work-orders", label: "Work orders", href: "/maintenance/work-orders" },
  { key: "clearance", label: "Clearance queue", href: "/maintenance/clearance" },
  { key: "preventive", label: "Preventive", href: "/maintenance/preventive" },
  { key: "shop", label: "Shop capacity", href: "/maintenance/shop" },
] as const;

export function MaintenanceTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Maintenance sections" className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-4 pt-1.5 pb-[7px] text-sm leading-5 font-semibold whitespace-nowrap transition-colors duration-150",
            t.key === active ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

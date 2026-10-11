import Link from "next/link";
import { cn } from "@/lib/cn";

const TABS = [
  { key: "overview", label: "Overview", href: "/maintenance" },
  { key: "work-orders", label: "Work orders", href: "/maintenance/work-orders" },
  { key: "clearance", label: "Clearance queue", href: "/maintenance/clearance" },
  { key: "preventive", label: "Preventive", href: "/maintenance/preventive" },
] as const;

export function MaintenanceTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Maintenance sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-semibold whitespace-nowrap",
            t.key === active ? "border-strong text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

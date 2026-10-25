import Link from "next/link";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/fleet", label: "Overview" },
  { href: "/fleet/trucks", label: "Trucks" },
  { href: "/fleet/trailers", label: "Trailers" },
  { href: "/fleet/drivers", label: "Drivers" },
] as const;

export type FleetTab = (typeof TABS)[number]["label"];

/** Section tabs shown at the top of every fleet page. */
export function FleetNav({ active }: { active: FleetTab }) {
  return (
    <nav aria-label="Fleet sections" className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.label === active ? "page" : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors duration-150",
            t.label === active ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

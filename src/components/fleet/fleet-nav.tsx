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
    <nav aria-label="Fleet sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.label === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-4 py-2.5 text-[15px] font-semibold whitespace-nowrap transition-colors",
            t.label === active ? "border-brand text-ink" : "border-transparent text-muted hover:border-line hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

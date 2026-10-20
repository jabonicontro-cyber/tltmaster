import Link from "next/link";
import { cn } from "@/lib/cn";
import { KIT_SECTIONS, type KitSectionKey } from "@/lib/onboarding/kit";

/** The kit's sections as links (each section is its own URL, so it can be bookmarked and shared). */
export function KitNav({ base, current }: { base: string; current: KitSectionKey }) {
  return (
    <nav aria-label="Onboarding sections" className="mb-5 flex gap-1 overflow-x-auto pb-1">
      {KIT_SECTIONS.map((s) => (
        <Link key={s.key} href={`${base}?section=${s.key}`} aria-current={current === s.key ? "page" : undefined}
          className={cn("shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold whitespace-nowrap", current === s.key ? "bg-strong text-white" : "text-muted hover:bg-surface hover:text-ink")}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

export function kitSection(raw: string | undefined): KitSectionKey {
  return (KIT_SECTIONS.find((s) => s.key === raw)?.key ?? "overview") as KitSectionKey;
}

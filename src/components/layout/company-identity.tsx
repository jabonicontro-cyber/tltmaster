import { cn } from "@/lib/cn";

/**
 * The company's own identity in its workspace: its logo when one is set,
 * otherwise a monogram in the company's accent color with the company name (the monogram alone in the
 * collapsed rail).
 * Taviron appears only as a small "Powered by Taviron" line elsewhere.
 */
export function CompanyIdentity({ name, logoUrl, tone = "light", compact = false, className }: { name: string | null; logoUrl: string; tone?: "light" | "dark"; /** Square mark only (the collapsed sidebar rail). */ compact?: boolean; className?: string }) {
  const label = name || "Your company";
  // The collapsed rail is a small square: most logos are wide wordmarks that would be unreadable there,
  // so it shows the monogram in the company's colour; the full logo shows when the sidebar is expanded.
  if (logoUrl && !compact) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a small per-company image served by our own route
      <img src={logoUrl} alt={label} className={cn("h-8 w-auto max-w-40 min-w-0 rounded-lg bg-white object-contain object-left p-1", className)} />
    );
  }
  const initials = label.replace(/\(.*?\)/g, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "C";
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand text-[13px] font-semibold text-white" aria-hidden={!compact} role={compact ? "img" : undefined} aria-label={compact ? label : undefined}>
        {initials}
      </span>
      {!compact && <span className={cn("line-clamp-2 text-sm leading-tight font-semibold", tone === "light" ? "text-white" : "text-ink")}>{label}</span>}
    </span>
  );
}

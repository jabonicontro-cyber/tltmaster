import { cn } from "@/lib/cn";

/**
 * Taviron logo for the public website and platform area: a geometric T emblem
 * (blue only as an accent inside the symbol) and the TAVIRON wordmark. Interim
 * artwork until the production brand package exists; no ® until registration.
 */
export function TavironEmblem({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden focusable="false">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="#10233a" stroke="#c7d1de" strokeOpacity="0.28" />
      <path d="M7 8h12.5v5H18.5v12h-5V13H7z" fill="#f7f9fc" />
      <path d="M20.5 8H25v5h-4.5z" fill="#168bff" />
    </svg>
  );
}

export function TavironLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <TavironEmblem />
      <span className="text-[15px] font-semibold tracking-[0.22em] text-cloud">TAVIRON</span>
    </span>
  );
}

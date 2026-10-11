import { cn } from "@/lib/cn";

/**
 * Taviron's own mark for first-party screens (sign-in, onboarding, the
 * platform area): the geometric T emblem — blue only as an accent inside the
 * symbol — and the TAVIRON wordmark. No ® until registration. Inside a company
 * workspace the company's identity comes first (see app-shell.tsx).
 */
export function TavironEmblem({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8 shrink-0", className)} aria-hidden focusable="false">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="#10233a" stroke="#c7d1de" strokeOpacity="0.28" />
      <path d="M7 8h12.5v5H18.5v12h-5V13H7z" fill="#f7f9fc" />
      <path d="M20.5 8H25v5h-4.5z" fill="#168bff" />
    </svg>
  );
}

export function BrandMark({ className, tone = "light" }: { className?: string; tone?: "light" | "dark" }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 leading-none", className)}>
      <TavironEmblem />
      <span className={cn("text-[15px] font-semibold tracking-[0.22em]", tone === "light" ? "text-white" : "text-ink")}>TAVIRON</span>
    </span>
  );
}

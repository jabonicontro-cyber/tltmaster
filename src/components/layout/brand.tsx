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

/**
 * The Taviron lockup: emblem, wordmark and an optional badge (e.g. "Platform") as one unit, so every first-party
 * header composes it the same way. Alignment comes from the type, not offsets: the all-caps wordmark and badge trim
 * their line boxes to cap height (text-box), so flex centring puts the letters on the emblem's centre line instead
 * of riding high on unused descender space; the trailing letter-spacing of tracked caps is cancelled so the gaps on
 * both sides of the wordmark measure the same. Browsers without text-box fall back to leading-none (≤1px off).
 */
export function BrandMark({ className, tone = "light", badge }: { className?: string; tone?: "light" | "dark" | "site"; badge?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 leading-none", className)}>
      <TavironEmblem />
      <span
        className={cn(
          "mr-[-0.22em] text-[15px] leading-none font-semibold tracking-[0.22em] [text-box:trim-both_cap_alphabetic]",
          tone === "light" ? "text-white" : tone === "site" ? "text-cloud" : "text-ink",
        )}
      >
        TAVIRON
      </span>
      {badge ? (
        <span className="ml-1 inline-flex items-center rounded bg-brand py-[5px] pr-[calc(0.375rem-0.12em)] pl-1.5 text-[10px] leading-none font-bold tracking-[0.12em] text-white uppercase [text-box:trim-both_cap_alphabetic]">
          {badge}
        </span>
      ) : null}
    </span>
  );
}

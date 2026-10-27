import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A progress ring for a share of a whole (e.g. trucks ready of the fleet). The figure in the middle is the part; the
 * caption says what it is out of. With no whole (0), the ring is an empty track and the figure reads "—".
 */
export function Ring({ part, whole, label, caption, tone = "brand", size = 104 }: {
  part: number;
  whole: number;
  label: string;
  caption?: ReactNode;
  tone?: "brand" | "amber" | "critical" | "green";
  size?: number;
}) {
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const share = whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
  const color = { brand: "stroke-brand", amber: "stroke-amber-400", critical: "stroke-critical", green: "stroke-green-600" }[tone];
  return (
    <figure className="flex flex-col items-center gap-2 text-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="-rotate-90" width={size} height={size} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-ink/[0.07]" />
          {share > 0 && (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" className={cn(color, "transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none")} strokeDasharray={c} strokeDashoffset={c * (1 - share)} />
          )}
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl leading-none font-semibold tracking-[-0.03em] tabular text-ink">{whole > 0 ? part : "—"}</span>
          {whole > 0 && <span className="mt-1 text-[11px] tabular text-muted">of {whole}</span>}
        </span>
      </div>
      <figcaption className="text-sm">
        <span className="font-semibold text-ink">{label}</span>
        {caption && <span className="block text-xs text-muted">{caption}</span>}
      </figcaption>
    </figure>
  );
}

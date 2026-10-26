import { cn } from "@/lib/cn";

// Small server-rendered SVG charts for Reports (redesign 2026-10-26). No chart library: lines, an area, a donut and a
// gauge, each with a text equivalent (aria-label or <title>) so the numbers are never only a picture.

export const SERIES = ["var(--color-brand)", "#38bdf8", "#818cf8", "#14b8a6", "#f59e0b", "#94a3b8"];

function path(values: number[], w: number, h: number, pad = 2) {
  const max = Math.max(...values, 0) || 1;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)] as const);
}

/** A trend line for a KPI card. */
export function Sparkline({ values, label, className }: { values: number[]; label: string; className?: string }) {
  if (values.length < 2) return null;
  const pts = path(values, 120, 36);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 120 36" className={cn("h-9 w-28 overflow-visible", className)} role="img" aria-label={label}>
      <path d={`${d} L118,34 L2,34 Z`} fill="currentColor" opacity={0.1} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The period's trend: an area for the main series with labelled axes; each point has a tooltip. */
export function AreaChart({ points, format, label }: { points: Array<{ label: string; value: number; detail?: string }>; format: (n: number) => string; label: string }) {
  const W = 760;
  const H = 240;
  const left = 64;
  const bottom = 28;
  const max = Math.max(...points.map((p) => p.value), 0);
  const top = niceMax(max);
  const plotW = W - left - 8;
  const plotH = H - bottom - 8;
  const x = (i: number) => left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => 8 + plotH - (top ? (v / top) * plotH : 0);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const every = Math.max(1, Math.ceil(points.length / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
      <defs>
        <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--color-brand)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={W - 8} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeDasharray="4 4" />
          <text x={left - 10} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px] tabular">{format(t)}</text>
        </g>
      ))}
      {points.length > 1 && <path d={`${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#area-fill)" />}
      <path d={line} fill="none" stroke="var(--color-brand)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.value)} r={3.5} fill="var(--color-card)" stroke="var(--color-brand)" strokeWidth={2}>
            <title>{`${p.label}: ${format(p.value)}${p.detail ? ` · ${p.detail}` : ""}`}</title>
          </circle>
          {i % every === 0 || i === points.length - 1 ? (
            <text x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-muted text-[11px]">{p.label}</text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

/** A round number at or above n, for the chart's top line. */
export function niceMax(n: number) {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  const f = n / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

/** Shares of a whole, with the total in the middle. */
export function Donut({ parts, center, sub, label }: { parts: Array<{ label: string; value: number; color?: string }>; center: string; sub: string; label: string }) {
  const total = parts.reduce((t, p) => t + p.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="size-40" role="img" aria-label={label}>
      <circle cx={70} cy={70} r={R} fill="none" stroke="var(--color-line)" strokeWidth={16} />
      {total > 0 &&
        parts.map((p, i) => {
          const len = (p.value / total) * C;
          const el = (
            <circle key={i} cx={70} cy={70} r={R} fill="none" stroke={p.color ?? SERIES[i % SERIES.length]} strokeWidth={16} strokeDasharray={`${Math.max(len - 2, 0)} ${C}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)">
              <title>{`${p.label}: ${Math.round((p.value / total) * 100)}%`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      <text x={70} y={68} textAnchor="middle" className="fill-ink text-[17px] font-semibold tabular">{center}</text>
      <text x={70} y={86} textAnchor="middle" className="fill-muted text-[10px]">{sub}</text>
    </svg>
  );
}

/** A half-circle gauge for a rate between 0 and 1. */
export function Gauge({ rate, label }: { rate: number | null; label: string }) {
  const R = 80;
  const half = Math.PI * R;
  const r = rate === null ? 0 : Math.min(Math.max(rate, 0), 1);
  return (
    <svg viewBox="0 0 200 112" className="w-full max-w-64" role="img" aria-label={label}>
      <path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="var(--color-line)" strokeWidth={18} strokeLinecap="round" />
      {rate !== null && r > 0 && (
        <path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="var(--color-brand)" strokeWidth={18} strokeLinecap="round" strokeDasharray={`${r * half} ${half}`} />
      )}
    </svg>
  );
}

/** A thin share bar for table rows. */
export function ShareBar({ value, max, tone = "brand" }: { value: number; max: number; tone?: "brand" | "muted" }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line/70" aria-hidden>
      <span className={cn("block h-full rounded-full", tone === "brand" ? "bg-brand" : "bg-muted/50")} style={{ width: `${pct}%` }} />
    </span>
  );
}

import { Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { formatCents } from "@/lib/money";
import type { Verdict } from "@/lib/quotes/pricing-help";
import type { QuotePricingHelp } from "@/server/data/pricing-help";

const VERDICT: Record<Verdict, { label: string; tone: "green" | "amber" | "red" | "gray" | "blue" }> = {
  in_line: { label: "In line", tone: "green" },
  high: { label: "Higher than you usually win", tone: "amber" },
  low: { label: "Lower than you usually win", tone: "blue" },
  below_cost: { label: "Below cost", tone: "red" },
  no_history: { label: "Not enough history", tone: "gray" },
};

/**
 * Pricing help (B114): for each priced line, the rates of the company's own won and lost quotes and a suggested rate
 * with its reasoning. Internal only (never on the customer document) and a suggestion: nothing changes the quote.
 */
export function PricingHelpCard({ help }: { help: QuotePricingHelp }) {
  return (
    <Card className="print:hidden">
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Lightbulb className="size-4 text-brand-fg" aria-hidden />Pricing help</span>}
        description={`From your decided quotes of the last 12 months${help.miles !== null ? ` · this job is about ${Math.round(help.miles)} mi from your yard (straight line)` : ""}${help.costShown ? " · per-load lines compared with your measured cost per load" : ""}. A suggestion only — you set the price; customers never see this.`}
      />
      <ul className="divide-y divide-line border-t border-line" aria-label="Pricing help">
        {help.lines.map((l) => {
          const v = VERDICT[l.verdict];
          return (
            <li key={`${l.name}|${l.unit}`} className="px-5 py-3.5 sm:px-6">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-ink">{l.name}</span>
                <span className="text-sm text-muted">per {l.unit}</span>
                <Badge tone={v.tone}>{v.label}</Badge>
                <span className="ml-auto text-sm tabular">
                  Yours <strong className="text-ink">{l.rateCents === null ? "—" : formatCents(l.rateCents)}</strong>
                  {l.suggestedCents !== null && <> · Suggested <strong className="text-ink">{formatCents(l.suggestedCents)}</strong></>}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">{l.reason}</p>
              {(l.won > 0 || l.lost > 0) && (
                <p className="mt-0.5 text-xs text-muted tabular">
                  {l.won} won{l.wonLowCents !== null ? ` (${formatCents(l.wonLowCents)}–${formatCents(l.wonHighCents!)})` : ""} · {l.lost} lost
                  {l.medianLostCents !== null ? ` (typical ${formatCents(l.medianLostCents)})` : ""}
                  {l.basis === "distance" && l.bandLabel ? ` · ${l.bandLabel.toLowerCase()} only` : ""}
                  {l.costPerLoadCents !== null ? ` · cost ≈ ${formatCents(l.costPerLoadCents)}/load` : ""}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

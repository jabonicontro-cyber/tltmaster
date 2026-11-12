import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_STATUS_TONES } from "@/lib/platform/leads";
import { pipelineColumn, pipelineDates, type PipelineLead } from "@/lib/platform/console";

/**
 * The lead pipeline (PC1): one column per status with each lead's demo date and follow-up. A second view of Leads;
 * changing a lead stays on its own page (open a card). Columns stack on a phone and scroll sideways on a laptop.
 */
export function LeadPipeline({ leads, today }: { leads: PipelineLead[]; today: string }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
      <ol className="grid grid-cols-1 gap-3 md:min-w-[72rem] md:grid-cols-6" aria-label="Lead pipeline">
        {LEAD_STATUSES.map((s) => {
          const col = pipelineColumn(leads, s);
          return (
            <li key={s} className="flex min-w-0 flex-col rounded-panel border border-line bg-surface/60" aria-label={`${LEAD_STATUS_LABELS[s]}: ${col.length}`}>
              <h2 className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-sm font-semibold text-ink">
                <span>{LEAD_STATUS_LABELS[s]}</span>
                <span className="tabular text-muted">{col.length}</span>
              </h2>
              {col.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted">{s === "converted" || s === "not_proceeding" ? "None in the last 90 days." : "None."}</p>
              ) : (
                <ul className="space-y-2 p-2">
                  {col.map((l) => (
                    <li key={l.id}>
                      <Link href={`/admin/leads/${l.id}`} className="block rounded-xl border border-line bg-card p-3 shadow-xs transition-colors hover:border-strong/40">
                        <span className="block font-semibold break-words text-ink">{l.name}</span>
                        {l.company_name ? <span className="block text-sm break-words text-muted">{l.company_name}</span> : null}
                        <span className="mt-1.5 flex flex-wrap gap-1">
                          {pipelineDates(l, today).map((d) => <Badge key={d.text} tone={d.tone}>{d.text}</Badge>)}
                          {s === "converted" && l.onboarding_stage === "in_progress" ? <Badge tone={LEAD_STATUS_TONES.converted}>Onboarding</Badge> : null}
                        </span>
                        <span className="mt-1.5 block text-xs text-muted">
                          {l.owner_name ? `Owner: ${l.owner_name}` : "No owner yet"}
                          {l.truck_count !== null ? ` · ${l.truck_count} truck${l.truck_count === 1 ? "" : "s"}` : ""}
                          {l.kind === "contact" ? " · contact form" : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

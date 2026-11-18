import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { formatDateTime } from "@/lib/dates";
import { mistakeSummary } from "@/lib/tickets/mistakes";
import type { MistakeReport } from "@/server/data/ticket-mistakes";
import { MistakeResolve } from "./mistake-resolve";

/**
 * Drivers' "Mistake on my ticket" reports (owner decision 2026-11-17, TM1), in the office's ticket review: on the review
 * queue (open reports, each with its ticket) and on the ticket (every report on it). The office corrects the ticket with
 * the usual correction; that marks the report handled. "Mark handled" is for a report that needs no correction.
 */
export function MistakeReports({ reports, driverName, timeZone, canReview, title, description, ticketLinks = true, correctHref = null }: {
  reports: MistakeReport[];
  driverName: (id: string) => string;
  timeZone: string;
  canReview: boolean;
  title: string;
  description: string;
  /** Link each report to its ticket (the queue); off on the ticket's own page. */
  ticketLinks?: boolean;
  /** The ticket's correction page, for people who may correct tickets (the ticket's own page). */
  correctHref?: string | null;
}) {
  if (!reports.length) return null;
  return (
    <Card className="mb-5">
      <CardHeader title={title} description={description} />
      <ul className="divide-y divide-line" aria-label={title} data-testid="mistake-reports">
        {reports.map((r) => (
          <li key={r.id} className="px-5 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              {ticketLinks ? <Link href={`/tickets/${r.ticket_id}`} className="font-semibold tabular text-brand-fg hover:underline">{r.ticket_number}</Link> : null}
              <span className="font-semibold">{mistakeSummary(r.field, r.correct_value)}</span>
              <Badge tone={r.status === "open" ? "amber" : "green"}>{r.status === "open" ? "To check" : "Handled"}</Badge>
            </div>
            {r.note && <p className="mt-0.5 text-sm whitespace-pre-line">{r.note}</p>}
            <p className="mt-0.5 text-sm text-muted">
              From {driverName(r.driver_id)}, {formatDateTime(r.created_at, timeZone)}
              {r.has_photo && <> · <a href={`/tickets/mistake-photos/${r.id}`} target="_blank" rel="noreferrer" className="font-medium text-brand-fg underline">Photo</a></>}
            </p>
            {r.status === "resolved" ? (
              <p className="mt-0.5 text-sm text-muted">Handled{r.resolved_at ? ` ${formatDateTime(r.resolved_at, timeZone)}` : ""}: {r.resolution_note}</p>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {correctHref && <Link href={correctHref} className="text-sm font-semibold text-brand-fg underline">Correct the ticket</Link>}
                {canReview && <MistakeResolve reportId={r.id} />}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

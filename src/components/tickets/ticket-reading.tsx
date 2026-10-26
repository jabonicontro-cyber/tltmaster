"use client";

import Link from "next/link";
import { useState } from "react";
import { ScanText } from "lucide-react";
import { readTicketPhoto, type TicketReadingView } from "@/app/(app)/tickets/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GateState } from "@/lib/ai/capabilities";
import type { CheckVerdict } from "@/lib/ai/ticket-reading";

export interface TicketAiState {
  state: GateState;
  label: string;
  canRun: boolean;
  /** For people who manage settings: they are pointed to Company setup, where the reasons are listed. */
  reasons: string[] | null;
}

const VERDICT: Record<CheckVerdict, { text: string; tone: "green" | "amber" | "gray" }> = {
  matches: { text: "Matches", tone: "green" },
  differs: { text: "Check", tone: "amber" },
  not_read: { text: "Not read", tone: "gray" },
  nothing_to_compare: { text: "Nothing to compare", tone: "gray" },
};

/**
 * B84: an AI reading of the paper ticket photo, compared with what was entered and with the order. Labelled as an AI
 * reading; it never changes or accepts the ticket. A reviewer who finds a difference corrects the ticket themselves.
 */
export function TicketReading({ ticketId, photos, ai, correctHref }: { ticketId: string; photos: Array<{ id: string; label: string }>; ai: TicketAiState; correctHref: string | null }) {
  const [photoId, setPhotoId] = useState(photos[photos.length - 1]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{ photoId: string; data: TicketReadingView } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function read() {
    setBusy(true);
    setError(null);
    const r = await readTicketPhoto({ ticketId, photoId });
    setBusy(false);
    if (r.ok) setView({ photoId, data: r.data });
    else setError(r.error);
  }

  const differs = view?.data.checks.filter((c) => c.verdict === "differs").length ?? 0;
  return (
    <section aria-labelledby="ticket-reading-title" className="border-t border-line px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="ticket-reading-title" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ScanText className="size-4" aria-hidden /> Read the photo with AI
        </h3>
        {ai.canRun ? (
          <div className="flex flex-wrap items-center gap-2">
            {photos.length > 1 && (
              <select aria-label="Photo to read" value={photoId} onChange={(e) => setPhotoId(e.target.value)} className="h-9 rounded-control border border-line bg-card px-2 text-sm text-ink">
                {photos.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            )}
            <Button variant="secondary" size="sm" onClick={read} loading={busy} disabled={busy || !photoId}>{view ? "Read again" : "Read the photo"}</Button>
          </div>
        ) : (
          <span className="text-xs font-semibold text-muted">AI: {ai.label}</span>
        )}
      </div>
      {!ai.canRun && (
        <p className="mt-1 text-sm text-muted">
          AI ticket reading is not switched on for this company. Compare the photo with the entry above as usual.
          {ai.reasons && ai.reasons.length > 0 && <> Administrators can see what is missing in <Link href="/setup" className="font-semibold text-brand-fg hover:underline">Company setup</Link>.</>}
        </p>
      )}
      {error && <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">{error}</p>}
      {view && (
        <div className="mt-3 space-y-3" aria-live="polite">
          <p className="text-xs font-semibold text-muted">AI reading of the photo · check it against the photo · nothing on the ticket was changed</p>
          {!view.data.reading.readable ? (
            <p className="text-sm text-ink">The AI could not read a delivery ticket in this photo.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="AI reading cross-checks">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1.5 pr-3 font-medium">Field</th>
                    <th className="py-1.5 pr-3 font-medium">On the photo (AI)</th>
                    <th className="py-1.5 pr-3 font-medium">In Taviron</th>
                    <th className="py-1.5 font-medium">Check</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {view.data.checks.map((c) => (
                    <tr key={c.key} aria-label={c.label}>
                      <td className="py-2 pr-3 text-muted">{c.label}</td>
                      <td className="py-2 pr-3 font-medium text-ink tabular">{c.read ?? "—"}</td>
                      <td className="py-2 pr-3 text-ink tabular">{c.recorded ?? "—"}{c.note && <span className="block text-xs text-muted">{c.note}</span>}</td>
                      <td className="py-2"><Badge tone={VERDICT[c.verdict].tone}>{VERDICT[c.verdict].text}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {differs > 0 && (
            <p className="text-sm text-ink">
              {differs} value{differs === 1 ? "" : "s"} to check against the photo.{" "}
              {correctHref && <Link href={correctHref} className="font-semibold text-brand-fg hover:underline">Correct the ticket</Link>}
              {correctHref ? " if the entry is wrong; accept it if the photo agrees." : ""}
            </p>
          )}
          <p className="text-xs text-muted">
            Model {view.data.model} · tokens reported: {view.data.tokens.input ?? "?"} in / {view.data.tokens.output ?? "?"} out
            {view.data.estimatedCostUsd !== null ? ` · estimated cost $${view.data.estimatedCostUsd.toFixed(4)}` : " · cost not estimated"}
          </p>
        </div>
      )}
    </section>
  );
}

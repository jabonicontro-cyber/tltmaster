"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ShieldAlert, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { decideTriage, suggestTriage } from "@/app/(app)/maintenance/crew-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { WO_CATEGORIES, WO_URGENCIES } from "@/lib/maintenance";
import type { TriageRow } from "@/server/data/maintenance-crew";

const WORSENING = { yes: "Getting worse", no: "Not getting worse", unknown: "Not stated" } as const;
const STATUS = { accepted: "Accepted", edited: "Accepted with changes", rejected: "Rejected", suggested: "Waiting for review", superseded: "Replaced" } as const;

/** Triage of what was reported: quoted facts, open questions and a suggestion a person accepts, edits or rejects. */
export function TriageCard({ workOrderId, triage, canManage, open, decidedByName }: {
  workOrderId: string; triage: TriageRow | null; canManage: boolean; open: boolean; decidedByName: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const s = triage?.suggestion;
  const [edit, setEdit] = useState({ category: s?.category ?? "repair", urgency: s?.urgency ?? "normal", safety: s?.safetyReview ?? false, note: "" });
  const run = (fn: () => ReturnType<typeof decideTriage>) => start(async () => {
    const r = await fn();
    if (r.ok) { toast.success(r.message ?? "Saved."); setMode("view"); router.refresh(); } else toast.error(r.error);
  });

  if (!triage || !s) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted">No triage yet. Taviron can read the report and suggest a category, urgency, whether a safety review is needed and what to ask. You decide.</p>
        {canManage && open && <Button size="sm" variant="secondary" disabled={pending} icon={<Sparkles className="size-4" aria-hidden />} onClick={() => run(() => suggestTriage({ workOrderId }))}>Suggest triage</Button>}
      </div>
    );
  }

  const waiting = triage.status === "suggested";
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={triage.source === "ai" ? "blue" : "gray"}>{triage.source === "ai" ? "AI suggestion" : "Suggested by rules"}</Badge>
        <Badge tone={waiting ? "amber" : triage.status === "rejected" ? "gray" : "green"}>{STATUS[triage.status]}</Badge>
        {!waiting && decidedByName && <span className="text-xs text-muted">by {decidedByName}{triage.decisionNote ? ` · ${triage.decisionNote}` : ""}</span>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="What was reported">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Reported (quoted)</h4>
          {s.facts.length ? <ul className="space-y-1">{s.facts.map((f) => <li key={f} className="border-l-2 border-line pl-2 text-ink">“{f}”</li>)}</ul> : <p className="text-muted">Only the title: “{s.problem}”.</p>}
          <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1">
            <dt className="text-muted">Symptoms</dt><dd className="text-ink">{s.symptoms.length ? s.symptoms.join(", ") : "Not stated"}</dd>
            <dt className="text-muted">Started</dt><dd className="text-ink">{s.onset ?? "Not stated"}</dd>
            <dt className="text-muted">Worsening</dt><dd className="text-ink">{WORSENING[s.worsening]}</dd>
          </dl>
        </section>
        <section aria-label="Suggestion">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Suggestion (check before accepting)</h4>
          <p className="text-ink">{WO_CATEGORIES[s.category]} · {WO_URGENCIES[s.urgency]} urgency</p>
          {s.safetyReview && <p className="mt-1 flex items-start gap-1.5 font-medium text-critical"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> Safety review recommended: accepting marks this safety-critical and keeps the vehicle out of service until an inspection clears it.</p>}
          {s.reasons.length > 0 && <ul className="mt-1 list-disc pl-5 text-muted">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          {s.questions.length > 0 && <>
            <h4 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Ask the driver</h4>
            <ul className="list-disc pl-5 text-ink">{s.questions.map((q) => <li key={q}>{q}</li>)}</ul>
          </>}
          {s.related.length > 0 && <p className="mt-2 text-muted">Related open work: {s.related.map((r, i) => <span key={r.id}>{i > 0 && ", "}<Link href={`/maintenance/work-orders/${r.id}`} className="text-ink underline">{r.number}</Link></span>)}</p>}
        </section>
      </div>

      {waiting && canManage && open && mode === "view" && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button size="sm" disabled={pending} onClick={() => run(() => decideTriage({ workOrderId, triageId: triage.id, decision: "accepted" }))}>Accept</Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => { setEdit({ category: s.category, urgency: s.urgency, safety: s.safetyReview, note: "" }); setMode("edit"); }}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setEdit({ ...edit, note: "" }); setMode("reject"); }}>Reject</Button>
        </div>
      )}
      {mode === "edit" && (
        <form aria-label="Edit suggestion" className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); run(() => decideTriage({ workOrderId, triageId: triage.id, decision: "edited", ...edit })); }}>
          <Field label="Category" htmlFor="tri-cat"><Select id="tri-cat" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value as typeof edit.category })}>{Object.entries(WO_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Urgency" htmlFor="tri-urg"><Select id="tri-urg" value={edit.urgency} onChange={(e) => setEdit({ ...edit, urgency: e.target.value as typeof edit.urgency })}>{Object.entries(WO_URGENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <div className="sm:col-span-2"><Checkbox label="Safety-critical: keep the vehicle out of service until an inspection clears it" checked={edit.safety} onChange={(e) => setEdit({ ...edit, safety: e.target.checked })} /></div>
          <Field label="Note (optional)" htmlFor="tri-note" className="sm:col-span-2"><Input id="tri-note" value={edit.note} maxLength={1000} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field>
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" size="sm" disabled={pending}>Apply my changes</Button><Button size="sm" variant="ghost" onClick={() => setMode("view")}>Cancel</Button></div>
          <p className="text-xs text-muted sm:col-span-2">A safety flag already on this work order stays on: only someone who can clear vehicles removes it, after an inspection.</p>
        </form>
      )}
      {mode === "reject" && (
        <form aria-label="Reject suggestion" className="flex flex-wrap items-end gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); run(() => decideTriage({ workOrderId, triageId: triage.id, decision: "rejected", note: edit.note })); }}>
          <Field label="Why reject it?" htmlFor="tri-reason" className="min-w-0 flex-1"><Input id="tri-reason" value={edit.note} maxLength={1000} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="e.g. Already fixed on the road" /></Field>
          <Button type="submit" size="sm" variant="secondary" disabled={pending || edit.note.trim().length < 3}>Reject</Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Cancel</Button>
        </form>
      )}
      {!waiting && canManage && open && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => suggestTriage({ workOrderId }))}>Suggest again</Button>
      )}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { addCorrectiveAction, addWitness, closeIncident, completeCorrectiveAction, saveInvestigation } from "@/app/(app)/safety/actions";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action-result";
import { INCIDENT_KINDS, INCIDENT_SEVERITIES } from "@/lib/safety";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (p: () => Promise<ActionResult<unknown>>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await p();
      if (!r.ok) return setError(r.error);
      toast.success(r.message ?? "Saved.");
      after?.();
      router.refresh();
    });
  return { pending, error, run };
}

/** Classification, findings and root cause (safety.manage). The report itself stays as it was reported. */
export function InvestigationForm({ id, kind, severity, findings, rootCause }: { id: string; kind: string; severity: string; findings: string; rootCause: string }) {
  const { pending, error, run } = useRun();
  return (
    <form
      className="space-y-4"
      action={(f) => run(() => saveInvestigation({ id, kind: String(f.get("kind")), severity: String(f.get("severity")), findings: String(f.get("findings") ?? ""), root_cause: String(f.get("root_cause") ?? "") }))}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What happened" htmlFor="inv-kind">
          <Select id="inv-kind" name="kind" defaultValue={kind}>{Object.entries(INCIDENT_KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="How serious" htmlFor="inv-severity">
          <Select id="inv-severity" name="severity" defaultValue={severity}>{Object.entries(INCIDENT_SEVERITIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
      </div>
      <Field label="Findings" htmlFor="inv-findings" hint="What the investigation established. Kept apart from the report as it was made.">
        <Textarea id="inv-findings" name="findings" rows={4} maxLength={8000} defaultValue={findings} />
      </Field>
      <Field label="Root cause" htmlFor="inv-root">
        <Input id="inv-root" name="root_cause" maxLength={2000} defaultValue={rootCause} />
      </Field>
      <FormError message={error} />
      <Button type="submit" variant="secondary" disabled={pending}>{pending ? "Saving…" : "Save investigation"}</Button>
    </form>
  );
}

export function WitnessForm({ id }: { id: string }) {
  const { pending, error, run } = useRun();
  const [key, setKey] = useState(0);
  return (
    <form
      key={key}
      className="grid gap-3 sm:grid-cols-2"
      action={(f) => run(() => addWitness({ id, name: String(f.get("name") ?? ""), phone: String(f.get("phone") ?? ""), statement: String(f.get("statement") ?? "") }), () => setKey((k) => k + 1))}
    >
      <Field label="Name" htmlFor="w-name" required><Input id="w-name" name="name" maxLength={120} required /></Field>
      <Field label="Phone" htmlFor="w-phone"><Input id="w-phone" name="phone" type="tel" maxLength={40} /></Field>
      <Field label="Statement" htmlFor="w-statement" className="sm:col-span-2"><Textarea id="w-statement" name="statement" rows={2} maxLength={4000} /></Field>
      <div className="sm:col-span-2"><FormError message={error} /><Button type="submit" size="sm" variant="secondary" disabled={pending}>Add witness</Button></div>
    </form>
  );
}

export function ActionForm({ id, people, today }: { id: string; people: Array<{ value: string; label: string }>; today: string }) {
  const { pending, error, run } = useRun();
  const [key, setKey] = useState(0);
  return (
    <form
      key={key}
      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_10rem]"
      action={(f) => run(() => addCorrectiveAction({ id, description: String(f.get("description") ?? ""), assigned_to: String(f.get("assigned_to") ?? ""), due_on: String(f.get("due_on") ?? "") }), () => setKey((k) => k + 1))}
    >
      <Field label="Corrective action" htmlFor="a-desc" required><Input id="a-desc" name="description" maxLength={1000} required /></Field>
      <Field label="Who" htmlFor="a-who">
        <Select id="a-who" name="assigned_to" defaultValue=""><option value="">Unassigned</option>{people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
      </Field>
      <Field label="Due" htmlFor="a-due"><DateInput id="a-due" name="due_on" min={today} /></Field>
      <div className="sm:col-span-3"><FormError message={error} /><Button type="submit" size="sm" variant="secondary" disabled={pending}>Add action</Button></div>
    </form>
  );
}

export function CompleteActionButton({ incidentId, actionId }: { incidentId: string; actionId: string }) {
  const { pending, error, run } = useRun();
  return (
    <span className="inline-flex flex-col items-end">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => completeCorrectiveAction({ incidentId, actionId, note: "" }))}>Mark done</Button>
      {error && <span className="mt-1 text-xs text-critical" role="alert">{error}</span>}
    </span>
  );
}

export function CloseIncidentForm({ id, blocked }: { id: string; blocked: string | null }) {
  const { pending, error, run } = useRun();
  return (
    <form className="space-y-3" action={(f) => run(() => closeIncident({ id, note: String(f.get("note") ?? "") }))}>
      <Field label="Closing note (optional)" htmlFor="close-note"><Input id="close-note" name="note" maxLength={2000} /></Field>
      {blocked && <p className="text-sm text-muted">{blocked}</p>}
      <FormError message={error} />
      <Button type="submit" disabled={pending || Boolean(blocked)}>Close incident</Button>
    </form>
  );
}

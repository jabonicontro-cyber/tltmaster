"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { SCOPE_LABELS } from "@/lib/communications";
import { formatDate } from "@/lib/dates";
import type { Person } from "@/server/data/communications";
import { createWorkspace, previewWorkspace, type WorkspacePreview } from "@/app/(app)/communications/actions";
import { PeoplePicker } from "./people-picker";

type ScopeType = keyof typeof SCOPE_LABELS;

/**
 * Create an operational workspace. Drivers come from dispatch (active,
 * undelivered assignments in the scope); the recipient preview must be
 * reviewed before the workspace is created.
 */
export function WorkspaceForm(props: {
  date: string;
  orders: Array<{ id: string; label: string }>;
  loads: Array<{ id: string; label: string }>;
  sites: string[];
  staff: Person[];
  me: string;
}) {
  const router = useRouter();
  const [type, setType] = useState<ScopeType>("project");
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [loadIds, setLoadIds] = useState<string[]>([]);
  const [site, setSite] = useState(props.sites[0] ?? "");
  const [title, setTitle] = useState("");
  const [staff, setStaff] = useState<string[]>([]);
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const scope = type === "project" ? { scope_type: type, order_ids: orderIds }
    : type === "destination" ? { scope_type: type, site, date: props.date }
    : { scope_type: type, load_ids: loadIds };
  const changed = () => setPreview(null);

  return (
    <div className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-ink">Scope</legend>
        {(Object.keys(SCOPE_LABELS) as ScopeType[]).map((t) => (
          <label key={t} className="flex items-center gap-2 text-sm text-ink">
            <input type="radio" name="scope" className="accent-brand" checked={type === t} onChange={() => { setType(t); changed(); }} />
            {SCOPE_LABELS[t]}
          </label>
        ))}
      </fieldset>

      {type === "project" && (
        <Field label="Orders" htmlFor="ws-orders" hint="Hold Ctrl or ⌘ to choose more than one. Every load of these orders is in scope.">
          <Select id="ws-orders" multiple className="h-48" value={orderIds} onChange={(e) => { setOrderIds(Array.from(e.target.selectedOptions).map((o) => o.value)); changed(); }}>
            {props.orders.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </Field>
      )}
      {type !== "project" && (
        <form method="get" className="flex items-end gap-2">
          <Field label="Date" htmlFor="ws-date"><DateInput id="ws-date" name="date" defaultValue={props.date} /></Field>
          <Button type="submit" variant="secondary">Show</Button>
        </form>
      )}
      {type === "destination" && (
        <Field label="Destination" htmlFor="ws-site" hint={`Delivery sites with loads on ${formatDate(props.date)}.`}>
          <Select id="ws-site" value={site} onChange={(e) => { setSite(e.target.value); changed(); }}>
            {props.sites.length === 0 && <option value="">No loads on this date</option>}
            {props.sites.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
      )}
      {type === "loads" && (
        <Field label="Loads" htmlFor="ws-loads" hint="Hold Ctrl or ⌘ to choose more than one.">
          <Select id="ws-loads" multiple className="h-48" value={loadIds} onChange={(e) => { setLoadIds(Array.from(e.target.selectedOptions).map((o) => o.value)); changed(); }}>
            {props.loads.length === 0 && <option disabled>No loads on this date</option>}
            {props.loads.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </Field>
      )}

      <Field label="Name" htmlFor="ws-title" required hint="For example the job, customer site or destination.">
        <Input id="ws-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div>
        <p className="mb-1 text-sm font-semibold text-ink">Staff to include</p>
        <p className="mb-2 text-xs text-muted">You are added as a manager. Drivers are added from dispatch and are not chosen here.</p>
        <PeoplePicker people={props.staff} selected={staff} onChange={(s) => { setStaff(s); changed(); }} exclude={[props.me]} />
      </div>

      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Eye className="size-4" />} loading={pending && !preview} onClick={async () => {
          setPending(true); setError(null);
          const r = await previewWorkspace(scope);
          setPending(false);
          if (!r.ok) { setPreview(null); return setError(r.error); }
          setPreview(r.data);
        }}>Preview recipients</Button>
        <Button disabled={!preview} loading={pending && Boolean(preview)} onClick={async () => {
          setPending(true); setError(null);
          const r = await createWorkspace({ title, scope, staff });
          setPending(false);
          if (!r.ok) return setError(r.error);
          toast.success(r.message ?? "Workspace created.");
          router.push(`/communications/c/${r.data.id}`);
        }}>Create workspace</Button>
      </div>

      {preview && (
        <section aria-label="Recipient preview" className="space-y-3 rounded-md border border-line bg-surface/60 p-4 text-sm">
          <p className="font-semibold text-ink">Who will be in this workspace now</p>
          <div>
            <p className="text-xs font-bold tracking-wide text-muted uppercase">Drivers from dispatch ({preview.drivers.length})</p>
            {preview.drivers.length === 0 ? <p className="text-muted">No assigned drivers with a Taviron login yet. They join automatically when assigned.</p>
              : <ul className="list-inside list-disc text-ink">{preview.drivers.map((d) => <li key={d.user_id}>{d.name}</li>)}</ul>}
            {preview.drivers_without_login > 0 && <p className="mt-1 text-amber-900">{preview.drivers_without_login} assigned driver{preview.drivers_without_login === 1 ? " has" : "s have"} no Taviron login and cannot be included.</p>}
          </div>
          <div>
            <p className="text-xs font-bold tracking-wide text-muted uppercase">Staff ({staff.length + 1})</p>
            <p className="text-ink">You{staff.length ? `, ${props.staff.filter((p) => staff.includes(p.user_id)).map((p) => p.name).join(", ")}` : ""}</p>
          </div>
          <div>
            <p className="text-xs font-bold tracking-wide text-muted uppercase">Loads in scope ({preview.loads.length})</p>
            {preview.loads.length === 0 ? <p className="text-muted">No open loads in this scope.</p>
              : <ul className="max-h-40 list-inside list-disc overflow-y-auto text-ink">{preview.loads.map((l) => <li key={l.load_id}>{l.label} · {formatDate(l.date)}</li>)}</ul>}
          </div>
        </section>
      )}
    </div>
  );
}

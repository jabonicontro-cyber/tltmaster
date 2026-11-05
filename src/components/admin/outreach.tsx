"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ChangeEvent } from "react";
import { toast } from "sonner";
import { Button, buttonClasses } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action-result";
import { parseCsv } from "@/lib/platform/imports";
import {
  OUTREACH_STATUSES, OUTREACH_STATUS_LABELS, SEGMENTS, SEGMENT_LABELS, composeLinks, mapColumns, missingColumns, readCarrierRows,
  type FaqItem, type OutreachSettings, type ProspectInput, type ReadResult, type Segment,
} from "@/lib/platform/outreach";
import { addProspect, convertProspect, importProspects, recordOutreach, saveOutreachSettings, searchRegistry, updateProspect } from "@/app/admin/outreach/actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(p: () => Promise<ActionResult<T>>, after?: (r: T) => void) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        if (r.message) toast.success(r.message);
        after?.(r.data);
        router.refresh();
      } else toast.error(r.error);
    });
  return { pending, run };
}

const MAX_FILE_BYTES = 80_000_000;
const CHUNK = 500;

/**
 * Add carriers from the FMCSA registry: search it directly (public data, no key) or upload an export or any CSV with an
 * email and a company name. Nothing is saved until "Add". Addresses that asked not to be contacted are skipped by the
 * database.
 */
export function OutreachImport() {
  const router = useRouter();
  const [mode, setMode] = useState<"search" | "file">("search");
  const [table, setTable] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [states, setStates] = useState("");
  const [minUnits, setMinUnits] = useState("5");
  const [maxUnits, setMaxUnits] = useState("100");
  const [segments, setSegments] = useState<Segment[]>(["aggregate"]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [found, setFound] = useState<(ReadResult & { truncated: boolean; max: number }) | null>(null);

  const n = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
  const filters = { states: states.split(/[\s,]+/).filter(Boolean), minUnits: n(minUnits), maxUnits: n(maxUnits), segments, activeOnly };
  const map = useMemo(() => (table ? mapColumns(table[0] ?? []) : null), [table]);
  const missing = map ? missingColumns(map) : [];
  const fromFile = useMemo(() => {
    if (!table || missing.length) return null;
    return readCarrierRows(table, { states: states.split(/[\s,]+/), minUnits: n(minUnits), maxUnits: n(maxUnits), segments, activeOnly });
  }, [table, missing.length, states, minUnits, maxUnits, segments, activeOnly]);
  const result = mode === "search" ? found : fromFile;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    setReadError(null);
    setTable(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setReadError("The file is too large for the browser. On the census page, filter it (for example by state) before exporting.");
      return;
    }
    if (/\.(xlsx|xls|numbers|ods)$/i.test(file.name)) {
      setReadError("Save the spreadsheet as CSV first, then choose the CSV file.");
      return;
    }
    setFileName(file.name);
    setTable(parseCsv(await file.text()));
  }

  async function search() {
    setFound(null);
    if (!filters.states.length) {
      toast.error("Enter at least one state, like TX.");
      return;
    }
    setBusy(true);
    setProgress("Searching the FMCSA registry…");
    const r = await searchRegistry(filters);
    setBusy(false);
    setProgress(null);
    if (!r.ok) toast.error(r.error);
    else setFound(r.data);
  }

  async function add() {
    if (!result?.rows.length) return;
    setBusy(true);
    const source = mode === "search" || (map && map.fields.dot_number !== undefined) ? "fmcsa_census" : "csv";
    const total = { added: 0, updated: 0, suppressed: 0, invalid: 0 };
    for (let i = 0; i < result.rows.length; i += CHUNK) {
      setProgress(`Adding ${Math.min(i + CHUNK, result.rows.length).toLocaleString()} of ${result.rows.length.toLocaleString()}…`);
      const r = await importProspects(result.rows.slice(i, i + CHUNK), source);
      if (!r.ok) {
        toast.error(r.error);
        setBusy(false);
        setProgress(null);
        return;
      }
      for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += r.data[k];
    }
    setBusy(false);
    setProgress(null);
    toast.success(`${total.added.toLocaleString()} added, ${total.updated.toLocaleString()} already on the list${total.suppressed ? `, ${total.suppressed} skipped (asked not to be contacted)` : ""}.`);
    setTable(null);
    setFound(null);
    setFileName("");
    router.push("/admin/outreach");
    router.refresh();
  }

  const toggle = (s: Segment) => {
    setFound(null);
    setSegments((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  };
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    setFound(null);
    set(v);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-full bg-surface p-1 text-sm" role="radiogroup" aria-label="How to find companies">
        {([["search", "Search the registry"], ["file", "Upload a file"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)}
            className={mode === k ? "flex-1 rounded-full bg-card px-3 py-1.5 font-semibold text-ink shadow-xs" : "flex-1 rounded-full px-3 py-1.5 text-muted hover:text-ink"}>
            {label}
          </button>
        ))}
      </div>
      {mode === "search" ? (
        <p className="text-sm text-muted">Searches the FMCSA Company Census (public, free) for carriers that listed an email address. Nothing is added until you choose to.</p>
      ) : (
        <>
          <p className="text-sm text-muted">
            Export the FMCSA <a className="font-semibold text-brand-fg underline" href="https://data.transportation.gov/Trucking-and-Motorcoaches/Company-Census-File/az4n-8mr2" target="_blank" rel="noreferrer">Company Census File</a> as CSV, or use your own list with an email and a company name column.
          </p>
          <Field label="Carrier list (CSV)" htmlFor="outreach-file">
            <Input id="outreach-file" type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
          </Field>
          {readError && <p role="alert" className="text-sm text-critical">{readError}</p>}
          {map && missing.length > 0 && <p role="alert" className="text-sm text-critical">This file has no {missing.join(" or ")} column, so it can&apos;t be used.</p>}
        </>
      )}
      {(mode === "search" || (table && !missing.length)) && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={mode === "search" ? "States" : "States (blank for all)"} htmlFor="outreach-states" hint="For example: TX, OK, KS">
              <Input id="outreach-states" value={states} onChange={(e) => reset(setStates)(e.target.value)} placeholder="TX, OK" />
            </Field>
            <Field label="Trucks from" htmlFor="outreach-min">
              <Input id="outreach-min" inputMode="numeric" value={minUnits} onChange={(e) => reset(setMinUnits)(e.target.value)} />
            </Field>
            <Field label="Trucks up to" htmlFor="outreach-max">
              <Input id="outreach-max" inputMode="numeric" value={maxUnits} onChange={(e) => reset(setMaxUnits)(e.target.value)} />
            </Field>
            <div className="space-y-1.5 text-sm">
              <span className="font-semibold text-ink">Who</span>
              {SEGMENTS.map((s) => (
                <Checkbox key={s} label={SEGMENT_LABELS[s]} checked={segments.includes(s)} onChange={() => toggle(s)} />
              ))}
            </div>
          </div>
          {(mode === "search" || map?.active !== null) && <div><Checkbox label="Active carriers only" checked={activeOnly} onChange={(e) => reset(setActiveOnly)(e.target.checked)} /></div>}
          {mode === "search" && <div><Button variant={found ? "secondary" : "primary"} disabled={busy} onClick={search}>Search the registry</Button></div>}
          {result && (
            <p className="text-sm text-ink" data-testid="outreach-preview">
              <span className="font-semibold">{result.rows.length.toLocaleString()}</span> of {result.total.toLocaleString()} companies {mode === "file" ? `in ${fileName} ` : "found "}match
              {result.skipped.noEmail ? ` · ${result.skipped.noEmail.toLocaleString()} without an email` : ""}
              {result.skipped.duplicate ? ` · ${result.skipped.duplicate.toLocaleString()} repeated` : ""}.
              {mode === "search" && found?.truncated ? " That's the most one search brings back; narrow the states or truck range to see the rest." : ""}
              {mode === "file" && map && map.aggregateCargo.length === 0 && map.freightCargo.length === 0 ? " This file has no cargo columns, so everyone counts as Other." : ""}
            </p>
          )}
          {result && (
            <div className="flex items-center gap-3">
              <Button disabled={busy || !result.rows.length} onClick={add}>Add {result.rows.length ? result.rows.length.toLocaleString() : ""} to the list</Button>
            </div>
          )}
          {progress && <p className="text-sm text-muted" aria-live="polite">{progress}</p>}
        </>
      )}
    </div>
  );
}

export function AddProspectForm() {
  const router = useRouter();
  const { pending, run } = useRun();
  const [f, setF] = useState({ company_name: "", email: "", contact_name: "", phone: "", city: "", state: "", power_units: "", segment: "aggregate" as Segment });
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      aria-label="Add a company"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addProspect(f), (d) => { if (d.id) router.push(`/admin/outreach/${d.id}`); });
      }}
    >
      <Field label="Company" htmlFor="p-company" required><Input id="p-company" value={f.company_name} onChange={set("company_name")} required maxLength={160} /></Field>
      <Field label="Email" htmlFor="p-email" required><Input id="p-email" type="email" value={f.email} onChange={set("email")} required maxLength={254} /></Field>
      <Field label="Contact name" htmlFor="p-contact"><Input id="p-contact" value={f.contact_name} onChange={set("contact_name")} maxLength={120} /></Field>
      <Field label="Phone" htmlFor="p-phone"><Input id="p-phone" value={f.phone} onChange={set("phone")} maxLength={40} /></Field>
      <Field label="City" htmlFor="p-city"><Input id="p-city" value={f.city} onChange={set("city")} maxLength={80} /></Field>
      <Field label="State" htmlFor="p-state"><Input id="p-state" value={f.state} onChange={set("state")} maxLength={2} placeholder="TX" /></Field>
      <Field label="Trucks" htmlFor="p-units"><Input id="p-units" inputMode="numeric" value={f.power_units} onChange={set("power_units")} /></Field>
      <Field label="Kind of hauling" htmlFor="p-segment">
        <Select id="p-segment" value={f.segment} onChange={set("segment")}>
          {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
        </Select>
      </Field>
      <div className="sm:col-span-2"><Button type="submit" disabled={pending}>Add company</Button></div>
    </form>
  );
}

export function OutreachSettingsForm({ initial }: { initial: OutreachSettings }) {
  const { pending, run } = useRun();
  const [s, setS] = useState(initial);
  const setFaq = (i: number, k: keyof FaqItem, v: string) => setS({ ...s, faq: s.faq.map((f, n) => (n === i ? { ...f, [k]: v } : f)) });
  return (
    <form
      aria-label="Outreach email"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveOutreachSettings(s));
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Sender's name" htmlFor="o-sender" required hint="Shown in the email and its footer.">
          <Input id="o-sender" value={s.sender_name} onChange={(e) => setS({ ...s, sender_name: e.target.value })} maxLength={120} />
        </Field>
        <Field label="Postal address" htmlFor="o-address" required hint="Required in every commercial email (a street address or P.O. box).">
          <Input id="o-address" value={s.postal_address} onChange={(e) => setS({ ...s, postal_address: e.target.value })} maxLength={300} />
        </Field>
      </div>
      <Field label="Subject" htmlFor="o-subject">
        <Input id="o-subject" value={s.subject} onChange={(e) => setS({ ...s, subject: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Message" htmlFor="o-body" hint="Fill-ins: {{first_name}}, {{company}}, {{city}}, {{fleet}}, {{sender_name}}. The FAQ, where the address came from, the unsubscribe link and the postal address are added below it.">
        <Textarea id="o-body" rows={16} value={s.body} onChange={(e) => setS({ ...s, body: e.target.value })} maxLength={8000} />
      </Field>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">Common questions</legend>
        {s.faq.map((f, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_2fr_auto]">
            <Input aria-label={`Question ${i + 1}`} value={f.q} onChange={(e) => setFaq(i, "q", e.target.value)} maxLength={200} />
            <Textarea aria-label={`Answer ${i + 1}`} rows={2} value={f.a} onChange={(e) => setFaq(i, "a", e.target.value)} maxLength={1000} />
            <Button variant="ghost" size="sm" onClick={() => setS({ ...s, faq: s.faq.filter((_, n) => n !== i) })}>Remove</Button>
          </div>
        ))}
        {s.faq.length < 12 && <Button variant="secondary" size="sm" onClick={() => setS({ ...s, faq: [...s.faq, { q: "", a: "" }] })}>Add a question</Button>}
      </fieldset>
      <Button type="submit" disabled={pending}>Save email</Button>
    </form>
  );
}

/** The prepared email for one company: open it in Gmail or the mail app, or copy it; then record that it was sent. */
export function ProspectEmail({ id, email, blocked }: { id: string; email: { to: string; subject: string; body: string } | null; blocked: string | null }) {
  const { pending, run } = useRun();
  const [copied, setCopied] = useState(false);
  if (blocked || !email) return <p className="text-sm text-muted">{blocked}</p>;
  const links = composeLinks(email);
  const prepared = () => void recordOutreach(id, "prepared");
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Email preview">
        <p><span className="text-muted">To:</span> {email.to}</p>
        <p className="mt-1"><span className="text-muted">Subject:</span> <span className="font-semibold">{email.subject}</span></p>
        <pre className="mt-3 font-sans text-sm whitespace-pre-wrap text-ink">{email.body}</pre>
      </div>
      <div className="flex flex-wrap gap-2">
        <a className={buttonClasses("primary")} href={links.gmail} target="_blank" rel="noreferrer" onClick={prepared}>Open in Gmail</a>
        <a className={buttonClasses("secondary")} href={links.mailto} onClick={prepared}>Open in my mail app</a>
        <Button variant="secondary" onClick={async () => {
          try {
            await navigator.clipboard.writeText(`Subject: ${email.subject}\n\n${email.body}`);
            setCopied(true);
            prepared();
          } catch {
            toast.error("Copy is blocked in this browser; select the text above instead.");
          }
        }}>{copied ? "Copied" : "Copy email"}</Button>
        <Button variant="dark" disabled={pending} onClick={() => run(() => recordOutreach(id, "marked_sent"))}>I sent it</Button>
      </div>
      <p className="text-xs text-muted">Taviron doesn&apos;t send anything: you send the email from your own mailbox, then press &quot;I sent it&quot; so the list stays right.</p>
    </div>
  );
}

export function ProspectManage({ id, status, notes, leadId }: { id: string; status: string; notes: string; leadId: string | null }) {
  const router = useRouter();
  const { pending, run } = useRun();
  const [n, setN] = useState(notes);
  const [st, setSt] = useState(status);
  const locked = status === "do_not_contact";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Status" htmlFor="pr-status">
          <Select id="pr-status" value={st} disabled={locked} onChange={(e) => setSt(e.target.value)}>
            {OUTREACH_STATUSES.filter((s) => s !== "do_not_contact" || locked).map((s) => <option key={s} value={s}>{OUTREACH_STATUS_LABELS[s]}</option>)}
          </Select>
        </Field>
        <Button variant="secondary" disabled={pending || locked || st === status} onClick={() => run(() => updateProspect(id, st, null))}>Save status</Button>
      </div>
      <Field label="Notes" htmlFor="pr-notes" hint="What they said, who to ask for, when to follow up.">
        <Textarea id="pr-notes" rows={4} value={n} onChange={(e) => setN(e.target.value)} maxLength={2000} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={pending || n === notes} onClick={() => run(() => updateProspect(id, null, n))}>Save notes</Button>
        {leadId
          ? <a className={buttonClasses("secondary")} href={`/admin/leads/${leadId}`}>Open the lead</a>
          : !locked && <Button disabled={pending} onClick={() => run(() => convertProspect(id), (d) => router.push(`/admin/leads/${d.leadId}`))}>Add to Leads</Button>}
        {!locked && (
          <Button variant="danger" disabled={pending} onClick={() => {
            if (window.confirm("They asked not to be contacted? They will never be emailed again, and this can't be undone here.")) run(() => updateProspect(id, "do_not_contact", null));
          }}>Do not contact</Button>
        )}
      </div>
    </div>
  );
}

export type { ProspectInput };

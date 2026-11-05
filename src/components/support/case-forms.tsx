"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { PhotoPicker, uploadPhotos } from "@/components/ui/photo-picker";
import { openSupportCase, replySupportCase } from "@/app/(app)/support/actions";
import { checkSupportFiles, SUPPORT_ACCEPT, SUPPORT_KINDS, SUPPORT_MAX_FILES } from "@/lib/support";

type Option = { id: string; label: string };

/** Attachments on a message the person just sent; returns a note about any that could not be sent. */
async function attach(url: string, field: Record<string, string>, files: File[]): Promise<string> {
  if (!files.length) return "";
  const failed = await uploadPhotos(url, field, files);
  return failed ? ` ${failed} attachment${failed === 1 ? "" : "s"} could not be sent.` : "";
}

/** Open a case for a customer (a phone call, an email, a visit): the opening message is visible to the customer. */
export function NewCaseForm({ customers, customer, staff, me, links }: {
  customers: Option[]; customer: string; staff: Option[]; me: string;
  links: { orders: Option[]; tickets: Option[]; invoices: Option[] };
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const submit = (form: FormData) => start(async () => {
    setError(null);
    const bad = checkSupportFiles(files);
    if (bad) return setError(bad);
    const v = (k: string) => String(form.get(k) ?? "");
    const r = await openSupportCase({ customer, kind: v("kind") as never, subject: v("subject"), message: v("message"), order: v("order"), ticket: v("ticket"), invoice: v("invoice"), assign: v("assign") });
    if (!r.ok) return setError(r.error);
    const note = await attach("/support/files", { message: r.data.messageId }, files);
    if (note) toast.warning((r.message ?? "Case opened.") + note); else toast.success(r.message ?? "Case opened.");
    router.push(`/support/${r.data.id}`);
  });
  return (
    <form action={submit} className="space-y-4" aria-label="New support case">
      <FormError message={error} />
      <Field label="Customer" htmlFor="sc-customer" required>
        <Select id="sc-customer" value={customer} onChange={(e) => router.push(`/support/new?customer=${e.target.value}`)}>
          {!customer && <option value="">Choose a customer…</option>}
          {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
      </Field>
      {customer && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What it is about" htmlFor="sc-kind" required>
              <Select id="sc-kind" name="kind" defaultValue="">
                <option value="" disabled>Choose…</option>
                {Object.entries(SUPPORT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Assigned to" htmlFor="sc-assign">
              <Select id="sc-assign" name="assign" defaultValue={me}>
                <option value="">Nobody yet</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </Field>
          </div>
          <LinkFields links={links} />
          <Field label="Subject" htmlFor="sc-subject" required><Input id="sc-subject" name="subject" maxLength={160} required /></Field>
          <Field label="Message to the customer" htmlFor="sc-message" required hint="The customer sees this in their portal and gets an email notice.">
            <Textarea id="sc-message" name="message" rows={5} minLength={5} maxLength={4000} required />
          </Field>
          <PhotoPicker id="sc-files" label="Attachments (optional)" empty="Add photos or PDFs" accept={SUPPORT_ACCEPT} camera={false} files={files} onChange={setFiles} max={SUPPORT_MAX_FILES} hint="Up to 5 photos or PDFs, 10 MB each." />
          <Button type="submit" loading={busy}>Open case</Button>
        </>
      )}
    </form>
  );
}

export function LinkFields({ links, value, stacked }: { links: { orders: Option[]; tickets: Option[]; invoices: Option[] }; value?: { order?: string | null; ticket?: string | null; invoice?: string | null }; stacked?: boolean }) {
  return (
    <div className={stacked ? "space-y-3" : "grid gap-4 sm:grid-cols-3"}>
      {([["order", "Order", links.orders], ["ticket", "Ticket", links.tickets], ["invoice", "Invoice", links.invoices]] as const).map(([name, label, opts]) => (
        <Field key={name} label={`${label} (optional)`} htmlFor={`sc-${name}`}>
          <Select id={`sc-${name}`} name={name} defaultValue={value?.[name] ?? ""}>
            <option value="">None</option>
            {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </Field>
      ))}
    </div>
  );
}

/** Reply to the customer, or write an internal note only staff see; optionally close the case. */
export function CaseReplyForm({ request, closed }: { request: string; closed: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [internal, setInternal] = useState(false);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const send = (close: boolean) => start(async () => {
    setError(null);
    const bad = checkSupportFiles(files);
    if (bad) return setError(bad);
    const r = await replySupportCase({ request, body, internal, close });
    if (!r.ok) return setError(r.error);
    const note = r.data.messageId ? await attach("/support/files", { message: r.data.messageId }, files) : "";
    if (note) toast.warning((r.message ?? "Saved.") + note); else toast.success(r.message ?? "Saved.");
    setBody("");
    setFiles([]);
    router.refresh();
  });
  return (
    <section className="space-y-3" aria-label="Write to the customer">
      <FormError message={error} />
      <div role="radiogroup" aria-label="Reply or note" className="flex w-fit gap-1 rounded-full bg-ink/[0.05] p-1 text-sm font-semibold">
        {([[false, "Reply to customer"], [true, "Internal note"]] as const).map(([v, l]) => (
          <button key={l} type="button" role="radio" aria-checked={internal === v} onClick={() => setInternal(v)}
            className={internal === v ? "rounded-full bg-card px-3 py-1.5 text-ink shadow-xs" : "rounded-full px-3 py-1.5 text-muted"}>{l}</button>
        ))}
      </div>
      <Field label={internal ? "Note (staff only: never shown to the customer)" : "Reply"} htmlFor="sc-body">
        <Textarea id="sc-body" rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} className={internal ? "bg-amber-50/60" : undefined} />
      </Field>
      <PhotoPicker id="sc-reply-files" label="Attachments (optional)" empty="Add photos or PDFs" accept={SUPPORT_ACCEPT} camera={false} files={files} onChange={setFiles} max={SUPPORT_MAX_FILES} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => send(false)} loading={busy} disabled={!body.trim()}>{internal ? "Save note" : "Send reply"}</Button>
        {!internal && !closed && <Button variant="secondary" onClick={() => send(true)} loading={busy}>{body.trim() ? "Send and close" : "Close case"}</Button>}
      </div>
    </section>
  );
}

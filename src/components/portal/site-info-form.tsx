"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Textarea } from "@/components/ui/form";
import { toJpeg } from "@/lib/files/to-jpeg";
import { submitSiteInfo } from "@/app/portal/actions";

/** Tell the hauler about one job site (B94): text first, then up to three photos; the office reviews it all. */
export function SiteInfoForm({ slug, siteId, siteLabel }: { slug: string; siteId: string; siteLabel: string }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What this browser just sent, shown as waiting for the office until the page is left (the page's data only has a
  // count of waiting notes, not their content).
  const [sent, setSent] = useState<{ lines: string[]; photos: number; failed: number } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      const r = await submitSiteInfo(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      let failed = 0;
      for (const file of files) {
        let blob: Blob = file;
        try { blob = await toJpeg(file); } catch { /* send as is; the server checks the type */ }
        const body = new FormData();
        body.set("file", new File([blob], "site.jpg", { type: blob.type || file.type }));
        body.set("submission", r.data.id);
        const res = await fetch(`/portal/${slug}/site-photos`, { method: "POST", body }).catch(() => null);
        if (!res || !res.ok) failed++;
      }
      toast.success(failed ? `Sent. ${failed} photo${failed === 1 ? "" : "s"} did not upload.` : r.message ?? "Sent to the office.");
      setSent({ lines: sentLines(fd), photos: files.length - failed, failed });
      form.reset();
      setFiles([]);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label={`Site details for ${siteLabel}`}>
      <div className="sm:col-span-2"><FormError message={error} /></div>
      {sent ? (
        <div role="status" className="rounded-xl border border-line bg-surface p-3 text-sm text-ink sm:col-span-2">
          <p className="font-semibold">Sent. Waiting for the office to check it</p>
          {sent.lines.length ? (
            <ul className="mt-1 space-y-0.5 text-muted">
              {sent.lines.map((l) => <li key={l} className="break-words">{l}</li>)}
            </ul>
          ) : null}
          <p className="mt-1 text-muted">
            {sent.photos ? `${sent.photos} photo${sent.photos === 1 ? "" : "s"}` : "No photos"}
            {sent.failed ? ` (${sent.failed} did not upload)` : ""}
          </p>
          <p className="mt-1 text-xs text-muted">Drivers see it once the office approves it. You can send another note below.</p>
        </div>
      ) : null}
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="site" value={siteId} />
      <Field label="Gate code" htmlFor={`gate-${siteId}`}><Input id={`gate-${siteId}`} name="gate" maxLength={60} autoComplete="off" /></Field>
      <Field label="Contact on site" htmlFor={`contact-${siteId}`}><Input id={`contact-${siteId}`} name="contact" maxLength={120} /></Field>
      <Field label="Contact phone" htmlFor={`phone-${siteId}`}><Input id={`phone-${siteId}`} name="phone" maxLength={40} inputMode="tel" /></Field>
      <Field label="Where to drop" htmlFor={`drop-${siteId}`}><Input id={`drop-${siteId}`} name="drop" maxLength={500} placeholder="e.g. north pile, behind the trailer" /></Field>
      <div className="sm:col-span-2">
        <Field label="Anything else drivers should know" htmlFor={`notes-${siteId}`}><Textarea id={`notes-${siteId}`} name="notes" rows={3} maxLength={2000} /></Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Photos (up to 3)" htmlFor={`photos-${siteId}`} hint="The gate, the drop spot or the way in. JPEG, PNG or WebP.">
          <input
            id={`photos-${siteId}`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 3))}
            className="block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-surface file:px-4 file:py-2 file:font-semibold"
          />
        </Field>
      </div>
      <div className="sm:col-span-2"><Button type="submit" loading={pending}>Send to the office</Button></div>
    </form>
  );
}

const SENT_FIELDS: Array<[string, string]> = [["gate", "Gate code"], ["contact", "Contact on site"], ["phone", "Contact phone"], ["drop", "Where to drop"], ["notes", "Notes"]];

/** The filled-in answers of one note, "Gate code: 4412", in the form's order. */
function sentLines(fd: FormData): string[] {
  return SENT_FIELDS.flatMap(([name, label]) => {
    const v = String(fd.get(name) ?? "").trim();
    return v ? [`${label}: ${v}`] : [];
  });
}

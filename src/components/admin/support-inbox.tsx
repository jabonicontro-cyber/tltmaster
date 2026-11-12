import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Field, Select, Textarea } from "@/components/ui/form";
import { EmptyState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { HELP_ARTICLES } from "@/lib/help/articles";
import {
  INBOX_FILTERS, REQUEST_STATUSES, REQUEST_STATUS_LABELS, REQUEST_STATUS_TONES, replyMailto, stageLabel,
  type Inbox, type InboxFilter, type SupportRequestDetail,
} from "@/lib/platform/console";
import { updateSupportRequest } from "@/app/staff/support-actions";
import { ConsoleTabs, Panel, PanelBody, PanelHeader } from "@/components/admin/ui";

// The support inbox (PC1): the same view for Admins (/admin/support) and Support staff (/staff/support). Requests are
// what customers sent from Help; staff set the status and record notes and replies. Nothing is emailed from here.

const articleTitle = new Map(HELP_ARTICLES.map((a) => [a.id, a.title]));

export function SupportInboxList({ inbox, filter, base }: { inbox: Inbox; filter: InboxFilter; base: string }) {
  const count = (k: InboxFilter) => (k === "open" ? inbox.counts.new + inbox.counts.answered : inbox.counts[k]);
  return (
    <Panel>
      <PanelHeader title="Support requests" description="Sent by people in customer companies from Help. Open one to answer it, add a note or close it. Nothing is emailed from Taviron: you send the answer from your own email." />
      <PanelBody className="border-b border-line">
        <ConsoleTabs label="Filter support requests" items={INBOX_FILTERS.map((f) => ({ href: f.key === "open" ? base : `${base}?status=${f.key}`, label: f.label, count: count(f.key), current: filter === f.key }))} />
      </PanelBody>
      {inbox.items.length === 0 ? (
        <EmptyState title={filter === "open" ? "No open requests" : "No requests here"} description={filter === "open" ? "Every request is answered or closed. New ones appear here as soon as someone sends one from Help." : "Try another filter."} className="py-8" />
      ) : (
        <ul className="divide-y divide-line" aria-label="Support requests">
          {inbox.items.map((r) => (
            <li key={r.id}>
              <Link href={`${base}/${r.id}`} className="block px-5 py-3 hover:bg-surface/60 sm:px-6">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={REQUEST_STATUS_TONES[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</Badge>
                  <span className="font-semibold text-ink">{r.company}</span>
                  {r.is_demo ? <Badge>Demo</Badge> : null}
                  <span className="text-sm text-muted">from {r.from_name}</span>
                  <span className="ml-auto text-xs text-muted">{formatDateTime(r.created_at)}</span>
                </span>
                <span className="mt-1 line-clamp-2 block text-sm whitespace-pre-wrap text-ink">{r.message}</span>
                <span className="mt-1 block text-xs text-muted">
                  {r.notes ? `${r.notes} note${r.notes === 1 ? "" : "s"}` : "No notes yet"}
                  {r.handled_by ? ` · last handled by ${r.handled_by}` : ""}
                  {r.page ? ` · sent from ${r.page}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const SAVED: Record<string, string> = {
  status: "Status saved.",
  note: "Note saved. Only the Taviron team sees notes.",
  reply: "Reply recorded. Nothing was emailed: send it from your email (the button below opens it).",
};

export function SupportRequestView({ r, base, level, saved, error }: { r: SupportRequestDetail; base: string; level: "admin" | "support"; saved?: string; error?: string }) {
  const lastReply = [...r.notes].reverse().find((n) => n.kind === "reply");
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        {error ? <Notice tone="warning" title="Not saved">{error}</Notice> : null}
        {saved && SAVED[saved] ? <p role="status" className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink">{SAVED[saved]}</p> : null}
        <Panel>
          <PanelHeader title="Their message" description={`Sent ${formatDateTime(r.created_at)}${r.page ? ` from ${r.page}` : ""}${r.article_id ? `, while reading “${articleTitle.get(r.article_id) ?? "a help article"}”` : ""}.`} />
          <PanelBody><p className="text-sm whitespace-pre-wrap text-ink" data-testid="request-message">{r.message}</p></PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Notes and replies" description="Notes are for the Taviron team only. Replies are the answer you wrote for the customer, kept here once you send it from your email." />
          {r.notes.length === 0 ? (
            <PanelBody><p className="text-sm text-muted">Nothing recorded yet.</p></PanelBody>
          ) : (
            <ol className="divide-y divide-line" aria-label="Notes and replies">
              {r.notes.map((n, i) => (
                <li key={`${n.at}:${i}`} className="px-5 py-3 text-sm sm:px-6">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={n.kind === "reply" ? "blue" : "gray"}>{n.kind === "reply" ? "Reply" : "Note"}</Badge>
                    <span className="font-semibold text-ink">{n.author}</span>
                    <span className="text-xs text-muted">{formatDateTime(n.at)}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-ink">{n.body}</p>
                </li>
              ))}
            </ol>
          )}
          {lastReply && r.from_email ? (
            <PanelBody className="border-t border-line">
              <a href={replyMailto(r.from_email, r.company, lastReply.body)} className="text-sm font-semibold text-brand-fg hover:underline">Open the latest reply in your email</a>
              <p className="mt-1 text-xs text-muted">Opens a new email to {r.from_email} in your own email program. Taviron does not send it.</p>
            </PanelBody>
          ) : null}
        </Panel>
      </div>
      <div className="space-y-5">
        <Panel>
          <PanelHeader title="From" />
          <PanelBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">Person</dt><dd className="break-words text-ink">{r.from_name}{r.from_role ? ` (${r.from_role})` : ""}</dd>
              <dt className="text-muted">Email</dt><dd className="break-words text-ink">{r.from_email ? <a href={`mailto:${r.from_email}`} className="underline">{r.from_email}</a> : "Not known"}</dd>
              <dt className="text-muted">Company</dt><dd className="break-words text-ink">{r.company}{r.is_demo ? " (demo)" : ""}</dd>
              <dt className="text-muted">Stage</dt><dd className="text-ink">{stageLabel(r.stage)}</dd>
            </dl>
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {level === "admin" && !r.is_demo ? <Link href={`/admin/companies/${r.company_id}`} className="font-semibold text-brand-fg hover:underline">Open the company</Link> : null}
              <Link href={`/staff?q=${encodeURIComponent(r.company)}`} className="font-semibold text-brand-fg hover:underline">Go in through Company access</Link>
            </p>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Answer or update" description="Change the status, write a note, or both." />
          <PanelBody>
            <form action={updateSupportRequest} className="space-y-3" aria-label="Update this request">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="base" value={base} />
              <Field label="Status" htmlFor="req-status">
                <Select id="req-status" name="status" defaultValue={r.status}>
                  {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{REQUEST_STATUS_LABELS[s]}</option>)}
                </Select>
              </Field>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium text-ink">What you are writing</legend>
                <label className="flex items-start gap-2 text-sm"><input type="radio" name="kind" value="note" defaultChecked className="mt-0.5" /><span>A note for the Taviron team</span></label>
                <label className="flex items-start gap-2 text-sm"><input type="radio" name="kind" value="reply" className="mt-0.5" /><span>A reply for the customer <span className="block text-xs text-muted">Recorded here; you send it from your own email.</span></span></label>
              </fieldset>
              <Field label="Note or reply" htmlFor="req-body" hint="Leave it empty when you only change the status.">
                <Textarea id="req-body" name="body" maxLength={4000} rows={5} />
              </Field>
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </form>
          </PanelBody>
        </Panel>
        <p className="text-sm"><Link href={base} className="font-semibold text-brand-fg hover:underline">Back to all requests</Link></p>
      </div>
    </div>
  );
}

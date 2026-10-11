"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, ClipboardList, Copy, Download, Mail, Pencil, Printer, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonClasses } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { allowedTransitions, canEditDraft, canRevise, canSend, QUOTE_STATUS_LABELS, transitionNeedsReason, type QuoteStatus } from "@/lib/quotes/status";
import { convertQuoteToOrder } from "@/app/(app)/orders/actions";
import { defaultEmailContent, markQuoteSent, reviseQuote, sendQuoteEmail, setQuoteStatus, type SendQuoteResult } from "@/app/(app)/quotes/actions";

interface Props {
  quoteId: string;
  quoteNumber: string;
  status: QuoteStatus;
  versionId: string;
  versionLocked: boolean;
  editSeq: number;
  permissions: { edit: boolean; send: boolean; status: boolean; convert: boolean };
  /** Order created from this quote, when one exists and the user can see orders. */
  order: { id: string; order_number: string } | null;
}

const STATUS_ACTION_LABEL: Partial<Record<QuoteStatus, string>> = {
  accepted: "Mark accepted",
  declined: "Mark declined",
  expired: "Mark expired",
  canceled: "Cancel quote",
};

export function QuoteActions({ quoteId, quoteNumber, status, versionId, versionLocked, editSeq, permissions, order }: Props) {
  const router = useRouter();
  const [emailOpen, setEmailOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<QuoteStatus | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  const [convertOpen, setConvertOpen] = useState(false);
  // A converted quote's status is fixed (enforced by the database).
  const transitions = permissions.status && !order ? allowedTransitions(status) : [];

  return (
    <div className="flex flex-wrap gap-2">
      {permissions.edit && canEditDraft(status, versionLocked) && (
        <Link href={`/quotes/${quoteId}/edit`} className={buttonClasses("primary")}>
          <Pencil className="size-4" aria-hidden /> Edit draft
        </Link>
      )}
      {permissions.send && canSend(status) && (
        <Button variant={status === "draft" ? "dark" : "secondary"} icon={<Mail className="size-4" />} onClick={() => setEmailOpen(true)}>
          {status === "sent" ? "Email again" : "Email quote"}
        </Button>
      )}
      {permissions.send && status === "draft" && (
        <Button variant="secondary" icon={<Send className="size-4" />} onClick={() => { setNote(""); setMarkOpen(true); }}>
          Mark as sent
        </Button>
      )}
      <Link href={`/quotes/${quoteId}/versions/${versionId}`} className={buttonClasses("secondary")}>
        <Printer className="size-4" aria-hidden /> Preview / print
      </Link>
      <a href={`/quotes/${quoteId}/versions/${versionId}/pdf?download=1`} className={buttonClasses("secondary")}>
        <Download className="size-4" aria-hidden /> PDF
      </a>
      {permissions.edit && canRevise(status, versionLocked) && (
        <Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => { setReason(""); setReviseOpen(true); }}>
          Revise
        </Button>
      )}
      {order && (
        <Link href={`/orders/${order.id}`} className={buttonClasses("primary")}>
          <ClipboardList className="size-4" aria-hidden /> Order {order.order_number}
        </Link>
      )}
      {!order && status === "accepted" && permissions.convert && (
        <Button icon={<ClipboardList className="size-4" />} onClick={() => setConvertOpen(true)}>
          Convert to order
        </Button>
      )}
      {transitions.map((t) => (
        <Button
          key={t}
          variant={t === "accepted" ? "primary" : t === "canceled" ? "danger" : "secondary"}
          icon={t === "accepted" ? <CheckCircle2 className="size-4" /> : t === "canceled" || t === "declined" ? <XCircle className="size-4" /> : undefined}
          onClick={() => { setNote(""); setStatusTarget(t); }}
        >
          {STATUS_ACTION_LABEL[t] ?? QUOTE_STATUS_LABELS[t]}
        </Button>
      ))}

      <ConfirmDialog
        open={convertOpen}
        onOpenChange={setConvertOpen}
        title={`Convert ${quoteNumber} to an order`}
        description="Creates an order from the accepted revision with the same customer, job site, lines, prices, discounts and totals. The quote and its revisions are kept unchanged, and its status can no longer change."
        confirmLabel="Create order"
        onConfirm={async () => {
          const r = await convertQuoteToOrder(quoteId);
          if (!r.ok) return r.error;
          if (r.data.created) toast.success(r.message ?? "Order created");
          else toast.info(r.message ?? "Opening existing order");
          router.push(`/orders/${r.data.orderId}`);
        }}
      />

      {emailOpen && <EmailDialog quoteId={quoteId} editSeq={versionLocked ? null : editSeq} onClose={() => setEmailOpen(false)} />}

      <ConfirmDialog
        open={markOpen}
        onOpenChange={setMarkOpen}
        title={`Mark ${quoteNumber} as sent`}
        description="Use this when the quote was delivered outside the system — printed, handed over, or emailed from another program. This version will be locked; later changes need a revision."
        confirmLabel="Mark as sent"
        onConfirm={async () => {
          const r = await markQuoteSent(quoteId, editSeq, note);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Marked as sent");
          router.refresh();
        }}
      >
        <Field label="How was it delivered?" htmlFor="mark-note" required>
          <Input id="mark-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Printed and handed to customer at the yard" />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={reviseOpen}
        onOpenChange={setReviseOpen}
        title={`Revise ${quoteNumber}`}
        description="Creates a new draft revision copied from the current version. The version the customer already received is kept unchanged."
        confirmLabel="Create revision"
        onConfirm={async () => {
          const r = await reviseQuote(quoteId, reason);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Revision created");
          router.push(`/quotes/${quoteId}/edit`);
        }}
      >
        <Field label="Reason for the revision" htmlFor="revise-reason" required hint="Recorded in the quote history.">
          <Input id="revise-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer asked for 40 tons instead of 22" />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(statusTarget)}
        onOpenChange={(o) => !o && setStatusTarget(null)}
        title={statusTarget ? `${STATUS_ACTION_LABEL[statusTarget] ?? QUOTE_STATUS_LABELS[statusTarget]} — ${quoteNumber}` : ""}
        description={
          statusTarget === "accepted"
            ? "Records that the customer accepted the current revision and creates its order (status Confirmed) with the accepted prices. Scheduling the order stays a separate step."
            : statusTarget === "canceled"
              ? "Canceled quotes cannot be reopened. History is kept."
              : undefined
        }
        confirmLabel={statusTarget ? STATUS_ACTION_LABEL[statusTarget] ?? "Confirm" : "Confirm"}
        tone={statusTarget === "canceled" ? "danger" : "primary"}
        onConfirm={async () => {
          if (!statusTarget) return;
          const r = await setQuoteStatus(quoteId, statusTarget, note);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Status updated");
          router.refresh();
        }}
      >
        {statusTarget && (
          <Field
            label={transitionNeedsReason(statusTarget) ? "Reason" : "Note (optional)"}
            htmlFor="status-note"
            required={transitionNeedsReason(statusTarget)}
          >
            <Input
              id="status-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={statusTarget === "accepted" ? "e.g. Accepted by phone — Pat Morgan" : ""}
            />
          </Field>
        )}
      </ConfirmDialog>
    </div>
  );
}

function splitEmails(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function EmailDialog({ quoteId, editSeq, onClose }: { quoteId: string; editSeq: number | null; onClose: () => void }) {
  const router = useRouter();
  const [loading, startLoading] = useTransition();
  const [sending, startSending] = useTransition();
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<string>("preview");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Extract<SendQuoteResult, { mode: "preview" }> | null>(null);

  useEffect(() => {
    startLoading(async () => {
      const r = await defaultEmailContent(quoteId);
      setLoaded(true);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setTo(r.data.to.join(", "));
      setSubject(r.data.subject);
      setMessage(r.data.message);
      setMode(r.data.emailMode);
    });
  }, [quoteId]);

  function send() {
    if (sending) return;
    setError(null);
    setFieldErrors({});
    startSending(async () => {
      let r: Awaited<ReturnType<typeof sendQuoteEmail>>;
      try {
        r = await sendQuoteEmail({ quoteId, expectedEditSeq: editSeq, to: splitEmails(to), cc: splitEmails(cc), subject, message });
      } catch {
        setError("The server could not be reached. The email was not sent.");
        return;
      }
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        router.refresh();
        return;
      }
      if (r.data.mode === "preview") {
        setPreview(r.data);
        router.refresh();
        return;
      }
      toast.success(r.data.mode === "test" ? `Test email sent to ${r.data.deliveredTo}. The quote was not marked sent.` : `Quote emailed to ${r.data.deliveredTo.join(", ")}.`);
      router.refresh();
      onClose();
    });
  }

  const fe = (k: string) => Object.entries(fieldErrors).find(([key]) => key === k || key.startsWith(`${k}.`))?.[1];

  return (
    <Dialog open onOpenChange={(o) => !o && !sending && onClose()} title="Email quote" description="The PDF of the current revision is attached. Sending locks this revision." size="lg">
      {preview ? (
        <div className="space-y-4">
          <Notice tone="warning" title="Preview only — nothing was sent">
            {preview.reason} This is exactly what would be sent once email is configured.
          </Notice>
          <dl className="space-y-1 rounded-md border border-line bg-surface p-3 text-sm">
            <div><dt className="inline font-semibold">To: </dt><dd className="inline">{preview.to.join(", ")}</dd></div>
            {preview.cc.length > 0 && <div><dt className="inline font-semibold">Cc: </dt><dd className="inline">{preview.cc.join(", ")}</dd></div>}
            <div><dt className="inline font-semibold">Subject: </dt><dd className="inline">{preview.subject}</dd></div>
            <div><dt className="inline font-semibold">Attachment: </dt><dd className="inline">{preview.filename}</dd></div>
          </dl>
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-white p-3 font-sans text-sm whitespace-pre-wrap">{preview.message}</pre>
          <p className="text-sm text-muted">
            If you emailed the quote yourself from another program, close this and use <strong>Mark as sent</strong>.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {mode === "preview" && loaded && (
            <Notice tone="warning" title="Email is not configured">
              Preview mode: you can review the email, but nothing will be sent and the quote will not be marked sent.
            </Notice>
          )}
          {mode === "test" && (
            <Notice tone="warning" title="Test mode">
              The email will go to the configured test inbox, not the customer. The quote will not be marked sent.
            </Notice>
          )}
          <FormError message={error} />
          <Field label="To" htmlFor="email-to" required error={fe("to")} hint="Separate several addresses with commas.">
            <Input id="email-to" value={to} onChange={(e) => setTo(e.target.value)} disabled={loading} />
          </Field>
          <Field label="Cc" htmlFor="email-cc" error={fe("cc")}>
            <Input id="email-cc" value={cc} onChange={(e) => setCc(e.target.value)} disabled={loading} />
          </Field>
          <Field label="Subject" htmlFor="email-subject" required error={fe("subject")}>
            <Input id="email-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={loading} />
          </Field>
          <Field label="Message" htmlFor="email-message" required error={fe("message")}>
            <Textarea id="email-message" rows={9} value={message} onChange={(e) => setMessage(e.target.value)} disabled={loading} />
          </Field>
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="secondary" onClick={onClose} disabled={sending}>Cancel</Button>
            <Button onClick={send} loading={sending} disabled={loading || !loaded} icon={<Send className="size-4" />}>
              {mode === "preview" ? "Preview email" : mode === "test" ? "Send test email" : "Send email"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

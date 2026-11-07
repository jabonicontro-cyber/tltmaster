"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyReference } from "@/components/ui/copy-reference";
import { FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDateTime } from "@/lib/dates";
import { approveSupportRequest, declineSupportRequest, withdrawSupportRequest } from "@/app/(app)/settings/support-actions";

export interface SupportRequestRow {
  id: string;
  kind: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  note: string;
  status: "pending" | "running" | "done" | "failed" | "declined" | "withdrawn" | "expired";
  result: string;
  requested_by: string;
  mine: boolean;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

const STATUS: Record<SupportRequestRow["status"], { label: string; tone: "gray" | "blue" | "green" | "amber" | "red" }> = {
  pending: { label: "Waiting for an owner", tone: "amber" },
  running: { label: "Being made", tone: "blue" },
  done: { label: "Approved and done", tone: "green" },
  failed: { label: "Approved, not done", tone: "red" },
  declined: { label: "Declined", tone: "gray" },
  withdrawn: { label: "Withdrawn", tone: "gray" },
  expired: { label: "Expired", tone: "gray" },
};

type Field = { label: string; value: string; secret?: boolean };

/**
 * Changes Taviron support asked for (SA2). While inside a company, staff cannot change who can sign in or what they may
 * do; the screen records the change here instead. An owner approves it (it then runs as the owner) or declines it.
 */
export function SupportRequests({ requests, canDecide, timezone }: { requests: SupportRequestRow[]; canDecide: boolean; timezone: string }) {
  const router = useRouter();
  const [handoff, setHandoff] = useState<{ summary: string; fields: Field[] } | null>(null);
  const waiting = requests.filter((r) => r.status === "pending");
  const past = requests.filter((r) => r.status !== "pending").slice(0, 15);

  return (
    <section className="space-y-4" aria-label="Changes Taviron support asked for">
      <div>
        <h3 className="text-sm font-semibold text-ink">Changes waiting for your approval</h3>
        <p className="mt-1 text-sm text-muted">
          Taviron support cannot add people, change roles or permissions, or reset sign-ins on their own. They ask here; nothing changes until an owner approves. Approving makes the change as you.
        </p>
      </div>

      {handoff && (
        <div role="status" className="space-y-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm" aria-label="Sign-in details to hand over">
          <p className="font-semibold text-ink">{handoff.summary}</p>
          <p className="text-muted">Give these to the person yourself. They are shown only now and are not saved.</p>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
            {handoff.fields.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-muted">{f.label}</dt>
                <dd className="flex items-center gap-1 font-medium break-all text-ink">
                  <span className={f.secret ? "font-mono" : undefined}>{f.value}</span>
                  <CopyReference value={f.value} label={f.label.toLowerCase()} />
                </dd>
              </div>
            ))}
          </dl>
          <Button size="sm" variant="secondary" onClick={() => { setHandoff(null); router.refresh(); }}>Done</Button>
        </div>
      )}

      {waiting.length === 0 ? (
        <p className="rounded-xl bg-surface px-4 py-3 text-sm text-muted">Nothing is waiting.</p>
      ) : (
        <ul className="space-y-3" aria-label="Waiting for approval">
          {waiting.map((r) => (
            <WaitingRequest key={r.id} r={r} canDecide={canDecide} timezone={timezone} onApproved={(summary, fields) => {
              if (fields.length) setHandoff({ summary, fields: fields.map((f) => (f.value.startsWith("/") ? { ...f, value: `${window.location.origin}${f.value}` } : f)) });
              else router.refresh();
            }} />
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Earlier requests</h3>
          <ul className="divide-y divide-line text-sm" aria-label="Earlier support requests">
            {past.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{r.summary}</span>
                  <span className="text-muted">, asked by {r.requested_by}</span>
                  {r.result && r.status === "failed" ? <span className="block text-xs text-critical">{r.result}</span> : null}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  {r.decided_by && r.decided_at ? `${r.decided_by}, ${formatDateTime(r.decided_at, timezone)}` : formatDateTime(r.created_at, timezone)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function WaitingRequest({ r, canDecide, timezone, onApproved }: {
  r: SupportRequestRow; canDecide: boolean; timezone: string; onApproved: (summary: string, fields: Field[]) => void;
}) {
  const router = useRouter();
  const approve = useFormAction(approveSupportRequest, { onSuccess: (res) => { toast.success(res.message ?? "Done."); onApproved(r.summary, res.data.fields); } });
  const decline = useFormAction(declineSupportRequest, { onSuccess: (res) => { toast.success(res.message ?? "Declined."); router.refresh(); } });
  const withdraw = useFormAction(withdrawSupportRequest, { onSuccess: (res) => { toast.success(res.message ?? "Withdrawn."); router.refresh(); } });
  const busy = approve.pending || decline.pending || withdraw.pending;
  return (
    <li className="rounded-xl border border-line bg-card px-4 py-3 text-sm shadow-xs" aria-label={r.summary}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{r.summary}</p>
          <p className="text-xs text-muted">Asked by {r.requested_by}, {formatDateTime(r.created_at, timezone)}. Expires {formatDateTime(r.expires_at, timezone)}.</p>
        </div>
        <Badge tone="amber">Waiting for an owner</Badge>
      </div>
      {r.details.length > 0 && (
        <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          {r.details.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-muted">{d.label}</dt>
              <dd className="text-ink break-words">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {r.note ? <p className="mt-2 text-muted">&ldquo;{r.note}&rdquo;</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {canDecide && (
          <>
            <form onSubmit={approve.onSubmit}>
              <input type="hidden" name="request" value={r.id} />
              <Button type="submit" size="sm" loading={approve.pending} disabled={busy}>Approve and make the change</Button>
            </form>
            <form onSubmit={decline.onSubmit}>
              <input type="hidden" name="request" value={r.id} />
              <Button type="submit" size="sm" variant="secondary" loading={decline.pending} disabled={busy}>Decline</Button>
            </form>
          </>
        )}
        {!canDecide && r.mine && (
          <form onSubmit={withdraw.onSubmit}>
            <input type="hidden" name="request" value={r.id} />
            <Button type="submit" size="sm" variant="secondary" loading={withdraw.pending} disabled={busy}>Withdraw</Button>
          </form>
        )}
        {!canDecide && !r.mine && <p className="text-xs text-muted">An owner of the company approves or declines this.</p>}
      </div>
      <div className="mt-2"><FormError message={approve.formError ?? decline.formError ?? withdraw.formError} /></div>
    </li>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyReference } from "@/components/ui/copy-reference";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDateTime } from "@/lib/dates";
import { inviteOwner, withdrawOwnerInvite, type OwnerInviteResult } from "@/app/admin/companies/owner-invite-actions";
import { PanelBody, PanelHeader } from "@/components/admin/ui";

export interface OwnerInvite { id: string; email: string; full_name: string; status: "open" | "accepted" | "withdrawn" | "expired"; created_at: string; expires_at: string; invited_by: string }
export interface OwnerInviteState { blocked: string | null; has_owner: boolean; invites: OwnerInvite[] }

const STATUS: Record<OwnerInvite["status"], { label: string; tone: "blue" | "green" | "gray" }> = {
  open: { label: "Waiting to accept", tone: "blue" }, accepted: { label: "Accepted", tone: "green" }, withdrawn: { label: "Withdrawn", tone: "gray" }, expired: { label: "Expired", tone: "gray" },
};

function InviteRow({ i, companyId }: { i: OwnerInvite; companyId: string }) {
  const router = useRouter();
  const withdraw = useFormAction(withdrawOwnerInvite, { onSuccess: (r) => { toast.success(r.message ?? "Withdrawn."); router.refresh(); } });
  const s = STATUS[i.status];
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm" aria-label={`Owner invitation for ${i.email}`}>
      <span className="font-medium text-ink">{i.full_name || i.email}</span>
      <span className="text-muted">{i.email}</span>
      <Badge tone={s.tone}>{s.label}</Badge>
      <span className="w-full text-xs text-muted sm:w-auto">{i.status === "open" ? `Link works until ${formatDateTime(i.expires_at)}` : `Sent ${formatDateTime(i.created_at)}`}{i.invited_by ? ` · by ${i.invited_by}` : ""}</span>
      {i.status === "open" && (
        <form onSubmit={withdraw.onSubmit} className="sm:ml-auto">
          <input type="hidden" name="invite" value={i.id} />
          <input type="hidden" name="company" value={companyId} />
          <Button type="submit" variant="secondary" size="sm" loading={withdraw.pending}>Withdraw</Button>
        </form>
      )}
      <FormError message={withdraw.formError} />
    </li>
  );
}

function Issued({ r, onDone }: { r: OwnerInviteResult; onDone: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4" role="status" aria-label="Owner invitation">
      <p className="font-semibold text-ink">Invitation for {r.fullName}, owner of {r.companyName}</p>
      <p className="text-sm text-muted">
        {r.emailed === "sent"
          ? `Emailed to ${r.email}. They open it, choose a password and set up an authenticator app.`
          : r.emailed === "test"
            ? `Sent to the test inbox only (email test mode), not to ${r.email}. Send them this link yourself, privately.`
            : `Not emailed${r.note ? `: ${r.note}` : "."} Send ${r.email} this link yourself, privately.`}
        {r.emailed !== "sent" ? " Because Taviron did not email it to them, they first confirm their email address with a code we email them." : ""}
        {" "}It works once and expires in 72 hours ({formatDateTime(r.expiresAt)}).{r.link ? " It is shown only now." : ""}
      </p>
      {r.link && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
          <code className="min-w-0 flex-1 truncate text-xs" aria-label="Invitation link">{r.link}</code>
          <CopyReference value={r.link} label="invitation link" />
        </div>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={onDone}>Done</Button>
    </div>
  );
}

/**
 * The company's first owner (PC2, Admins only): invite them while the company has no owner. The owner accepts the
 * invitation themselves (their own password and an authenticator app); after that they add everyone else from People.
 */
export function OwnerInviteCard({ companyId, companyName, state }: { companyId: string; companyName: string; state: OwnerInviteState }) {
  const router = useRouter();
  const [issued, setIssued] = useState<OwnerInviteResult | null>(null);
  const invite = useFormAction(inviteOwner, { onSuccess: (r) => { setIssued(r.data); toast.success(r.message ?? "Invitation created."); router.refresh(); } });
  const open = state.invites.find((i) => i.status === "open");
  return (
    <>
      <PanelHeader
        title="Owner"
        description={state.has_owner
          ? "This company has an owner. They add everyone else from People."
          : `${companyName} has no owner yet. Invite the person who runs it: they choose their own password, set up an authenticator app, and then add their team.`}
      />
      <PanelBody className="space-y-4">
        {state.invites.length > 0 && (
          <ul className="divide-y divide-line" aria-label="Owner invitations">{state.invites.map((i) => <InviteRow key={i.id} i={i} companyId={companyId} />)}</ul>
        )}
        {issued ? (
          <Issued r={issued} onDone={() => setIssued(null)} />
        ) : state.blocked ? (
          state.has_owner ? null : <p className="text-sm text-muted">{state.blocked}</p>
        ) : (
          <form onSubmit={invite.onSubmit} className="space-y-4 rounded-xl border border-line p-4" aria-label="Invite the owner" noValidate>
            <input type="hidden" name="company" value={companyId} />
            {open && <p className="text-sm text-muted">Sending a new invitation stops the waiting one for {open.email} from working.</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Owner's name" htmlFor="oi-name" error={invite.fieldError("full_name")}><Input id="oi-name" name="full_name" autoComplete="off" maxLength={120} /></Field>
              <Field label="Owner's email" htmlFor="oi-email" error={invite.fieldError("email")}><Input id="oi-email" name="email" type="email" autoComplete="off" maxLength={254} /></Field>
            </div>
            <p className="text-sm text-muted">To confirm it is you, enter your password and the current code from your authenticator app.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Your password" htmlFor="oi-pw" error={invite.fieldError("password")}><Input id="oi-pw" name="password" type="password" autoComplete="current-password" /></Field>
              <Field label="Your 6-digit code" htmlFor="oi-code" error={invite.fieldError("code")}><Input id="oi-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></Field>
            </div>
            <FormError message={invite.formError} />
            <Button type="submit" loading={invite.pending}>Send invitation</Button>
          </form>
        )}
      </PanelBody>
    </>
  );
}

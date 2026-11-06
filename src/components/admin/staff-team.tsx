"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyReference } from "@/components/ui/copy-reference";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDateTime } from "@/lib/dates";
import { inviteStaff, removeStaff, setStaffLevel, withdrawInvite, type StaffInviteResult } from "@/app/admin/team-actions";

export interface StaffMember { user_id: string; full_name: string; email: string; level: "admin" | "support"; granted_at: string; is_me: boolean }
export interface StaffInvite { id: string; email: string; full_name: string; level: "admin" | "support"; status: "open" | "accepted" | "withdrawn" | "expired"; created_at: string; expires_at: string; invited_by: string }

const LEVEL = { admin: "Admin", support: "Support" } as const;
const LEVEL_HINT = {
  support: "Goes into customer companies to help (with the customer's permission once they are live). No plans, prices or team.",
  admin: "Everything Support does, plus plans, prices, subscriptions and the team.",
} as const;
const INVITE_STATUS: Record<StaffInvite["status"], { label: string; tone: "blue" | "green" | "gray" }> = {
  open: { label: "Waiting", tone: "blue" }, accepted: { label: "Joined", tone: "green" }, withdrawn: { label: "Withdrawn", tone: "gray" }, expired: { label: "Expired", tone: "gray" },
};

function Member({ m }: { m: StaffMember }) {
  const router = useRouter();
  const done = (r: { message?: string }) => { toast.success(r.message ?? "Saved."); router.refresh(); };
  const level = useFormAction(setStaffLevel, { onSuccess: done });
  const remove = useFormAction(removeStaff, { onSuccess: done });
  const [to, setTo] = useState<StaffMember["level"]>(m.level);
  return (
    <li className="space-y-3 py-3" aria-label={`Team member ${m.full_name || m.email}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{m.full_name || m.email}</span>
        <Badge tone={m.level === "admin" ? "blue" : "gray"}>{LEVEL[m.level]}</Badge>
        {m.is_me && <span className="text-xs text-muted">You</span>}
        <span className="block w-full text-xs text-muted">{m.email}</span>
      </div>
      {!m.is_me && (
        <div className="flex flex-wrap items-end gap-2">
          <form onSubmit={level.onSubmit} className="flex flex-wrap items-end gap-2" aria-label={`Change ${m.full_name || m.email}'s level`}>
            <input type="hidden" name="user" value={m.user_id} />
            <Field label="Level" htmlFor={`lvl-${m.user_id}`}>
              <Select id={`lvl-${m.user_id}`} name="level" value={to} onChange={(e) => setTo(e.target.value as StaffMember["level"])}>
                <option value="support">Support</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            {to === "admin" && m.level !== "admin" && (
              <>
                <Field label="Your password" htmlFor={`lvl-pw-${m.user_id}`}><Input id={`lvl-pw-${m.user_id}`} name="password" type="password" autoComplete="current-password" className="w-40" /></Field>
                <Field label="Your 6-digit code" htmlFor={`lvl-code-${m.user_id}`}><Input id={`lvl-code-${m.user_id}`} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="w-28" /></Field>
              </>
            )}
            <Button type="submit" variant="secondary" size="sm" loading={level.pending} disabled={to === m.level}>Save level</Button>
          </form>
          <form onSubmit={(e) => { if (!window.confirm(`Remove ${m.full_name || m.email} from the Taviron team? Any company they are in right now is closed to them at once.`)) { e.preventDefault(); return; } remove.onSubmit(e); }}>
            <input type="hidden" name="user" value={m.user_id} />
            <Button type="submit" variant="secondary" size="sm" loading={remove.pending} className="text-critical">Remove</Button>
          </form>
        </div>
      )}
      <FormError message={level.formError ?? remove.formError} />
    </li>
  );
}

function InviteRow({ i }: { i: StaffInvite }) {
  const router = useRouter();
  const withdraw = useFormAction(withdrawInvite, { onSuccess: (r) => { toast.success(r.message ?? "Withdrawn."); router.refresh(); } });
  const s = INVITE_STATUS[i.status];
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span className="font-medium">{i.full_name || i.email}</span>
      <span className="text-muted">{i.email} · {LEVEL[i.level]}</span>
      <Badge tone={s.tone}>{s.label}</Badge>
      <span className="text-xs text-muted">{i.status === "open" ? `Expires ${formatDateTime(i.expires_at)}` : `Sent ${formatDateTime(i.created_at)}`}{i.invited_by ? ` by ${i.invited_by}` : ""}</span>
      {i.status === "open" && (
        <form onSubmit={withdraw.onSubmit} className="ml-auto">
          <input type="hidden" name="invite" value={i.id} />
          <Button type="submit" variant="secondary" size="sm" loading={withdraw.pending}>Withdraw</Button>
        </form>
      )}
    </li>
  );
}

function Issued({ r, onDone }: { r: StaffInviteResult; onDone: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4" role="status" aria-label="Invitation link">
      <p className="font-semibold text-ink">Invitation for {r.fullName} ({LEVEL[r.level]})</p>
      <p className="text-sm text-muted">
        {r.emailed === "sent" ? `Emailed to ${r.email}. ` : r.emailed === "test" ? "Sent to the test inbox (email test mode). " : `Not emailed${r.note ? `: ${r.note}` : "."} `}
        You can also send this link yourself. It works once and expires {formatDateTime(r.expiresAt)}. It is shown only now.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs" aria-label="Invitation link">{r.link}</code>
        <CopyReference value={r.link} label="invitation link" />
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={onDone}>Done</Button>
    </div>
  );
}

/**
 * The Taviron team (SA1): who is on it at which level, open invitations, and inviting someone. The invitee opens the
 * link, chooses a password, sets up an authenticator app and joins; nothing else is needed.
 */
export function StaffTeam({ members, invites }: { members: StaffMember[]; invites: StaffInvite[] }) {
  const router = useRouter();
  const [issued, setIssued] = useState<StaffInviteResult | null>(null);
  const [level, setLevel] = useState<"support" | "admin">("support");
  const invite = useFormAction(inviteStaff, { onSuccess: (r) => { setIssued(r.data); toast.success(r.message ?? "Invitation created."); router.refresh(); } });
  return (
    <div className="space-y-6">
      <ul className="divide-y divide-line text-sm" aria-label="Taviron team">
        {members.map((m) => <Member key={m.user_id} m={m} />)}
      </ul>

      {invites.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-ink">Invitations</h3>
          <ul className="divide-y divide-line" aria-label="Invitations">{invites.map((i) => <InviteRow key={i.id} i={i} />)}</ul>
        </div>
      )}

      {issued ? (
        <Issued r={issued} onDone={() => setIssued(null)} />
      ) : (
        <form onSubmit={invite.onSubmit} className="space-y-4 rounded-xl border border-line p-4" aria-label="Invite someone to the team" noValidate>
          <h3 className="text-sm font-semibold text-ink">Invite someone</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="st-name" error={invite.fieldError("full_name")}><Input id="st-name" name="full_name" autoComplete="off" maxLength={120} /></Field>
            <Field label="Email" htmlFor="st-email" error={invite.fieldError("email")}><Input id="st-email" name="email" type="email" autoComplete="off" maxLength={254} /></Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Level</legend>
            {(["support", "admin"] as const).map((l) => (
              <label key={l} className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-strong has-[:checked]:bg-surface">
                <input type="radio" name="level" value={l} checked={level === l} onChange={() => setLevel(l)} className="mt-0.5" />
                <span><span className="font-semibold">{LEVEL[l]}</span><span className="block text-muted">{LEVEL_HINT[l]}</span></span>
              </label>
            ))}
          </fieldset>
          <p className="text-sm text-muted">To confirm it is you, enter your password and the current code from your authenticator app.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Your password" htmlFor="st-pw" error={invite.fieldError("password")}><Input id="st-pw" name="password" type="password" autoComplete="current-password" /></Field>
            <Field label="Your 6-digit code" htmlFor="st-code" error={invite.fieldError("code")}><Input id="st-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></Field>
          </div>
          <FormError message={invite.formError} />
          <Button type="submit" loading={invite.pending}>Send invitation</Button>
        </form>
      )}
    </div>
  );
}

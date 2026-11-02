"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CredentialDelivery } from "@/components/accounts/credential-delivery";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDateTime } from "@/lib/dates";
import { changeAccountantAccess, emailAccountantSetup, inviteAccountant, type InvitedAccountant } from "@/app/(app)/settings/accountant-actions";

export interface AccountantRow { user_id: string; name: string; ends_at: string; payroll: boolean; current: boolean; last_visit: string | null }

/** The day before an end time, as YYYY-MM-DD in the company's zone (the last day of access). */
function lastDay(endsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.parse(endsAt) - 1000));
}

function Row({ a, today, timezone }: { a: AccountantRow; today: string; timezone: string }) {
  const router = useRouter();
  const done = (r: { message?: string }) => { toast.success(r.message ?? "Saved."); router.refresh(); };
  const save = useFormAction(changeAccountantAccess, { onSuccess: done });
  const end = useFormAction(changeAccountantAccess, { onSuccess: done });
  return (
    <li className="space-y-3 px-5 py-4 sm:px-6" aria-label={`Accountant ${a.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{a.name}</span>
        {a.current ? <Badge tone="green">Until {formatDateTime(a.ends_at, timezone)}</Badge> : <Badge tone="gray">Ended {formatDateTime(a.ends_at, timezone)}</Badge>}
        {a.payroll && <Badge tone="blue">Payroll included</Badge>}
        <span className="ml-auto text-sm text-muted">{a.last_visit ? `Last visit ${formatDateTime(a.last_visit, timezone)}` : "No visits yet"}</span>
      </div>
      <form onSubmit={save.onSubmit} className="flex flex-wrap items-end gap-3" aria-label={`Change ${a.name}'s access`}>
        <input type="hidden" name="user_id" value={a.user_id} />
        <Field label={a.current ? "Last day of access" : "Give access again until"} htmlFor={`acc-end-${a.user_id}`}>
          <DateInput id={`acc-end-${a.user_id}`} name="ends_on" min={today} defaultValue={a.current ? lastDay(a.ends_at, timezone) : ""} />
        </Field>
        <Checkbox name="payroll" label="Include driver payroll" defaultChecked={a.payroll} className="min-h-10" />
        <Button type="submit" variant="secondary" loading={save.pending}>{a.current ? "Save" : "Give access"}</Button>
      </form>
      {a.current && (
        <form onSubmit={(e) => { if (!window.confirm(`End ${a.name}'s access now? They will no longer see anything in the company.`)) { e.preventDefault(); return; } end.onSubmit(e); }}>
          <input type="hidden" name="user_id" value={a.user_id} />
          <input type="hidden" name="end_now" value="1" />
          <Button type="submit" variant="secondary" loading={end.pending} className="text-critical">End access now</Button>
        </form>
      )}
      <FormError message={save.formError ?? end.formError} />
    </li>
  );
}

/**
 * Accountant access (B134, owner 2026-11-02): an owner gives their outside accountant a read-only sign-in until a date
 * they choose, with driver payroll only if they tick it. Access ends by itself; it can be extended or ended early.
 */
export function AccountantAccess({ rows, today, timezone, defaultEnd, demo, companyName }: { rows: AccountantRow[]; today: string; timezone: string; defaultEnd: string; demo: boolean; companyName: string }) {
  const router = useRouter();
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [issued, setIssued] = useState<InvitedAccountant | null>(null);
  const invite = useFormAction(inviteAccountant, { onSuccess: (r) => { setIssued(r.data); toast.success(r.message ?? "Created."); router.refresh(); } });
  return (
    <div className="space-y-6">
      {issued && (
        <CredentialDelivery
          c={{ kind: "employee", personName: issued.personName, companyName, username: issued.username, loginUrl: issued.loginUrl, temporaryPassword: issued.temporaryPassword, expiresAt: issued.expiresAt }}
          email={issued.email ? { available: true, to: issued.email } : { available: false, reason: "No email was entered. Print or copy the sign-in instead." }}
          onEmail={() => emailAccountantSetup(issued.userId, issued.email)}
          onDone={() => { setIssued(null); setRequestKey(crypto.randomUUID()); }}
        />
      )}
      {rows.length > 0 ? (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Accountants">
          {rows.map((a) => <Row key={a.user_id} a={a} today={today} timezone={timezone} />)}
        </ul>
      ) : <p className="text-sm text-muted">No accountant has access.</p>}

      <form onSubmit={invite.onSubmit} className="space-y-4 rounded-xl border border-line p-4" aria-label="Give an accountant access" noValidate>
        <h3 className="text-base font-semibold">Give an accountant access</h3>
        {demo && <p className="text-sm text-muted">Demo companies do not create sign-ins: nothing real is created from a demo.</p>}
        <FormError message={invite.formError} />
        <input type="hidden" name="request_key" value={requestKey} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Accountant's name" htmlFor="acc-name" error={invite.fieldError("full_name")} required><Input id="acc-name" name="full_name" maxLength={120} disabled={demo} /></Field>
          <Field label="Username" htmlFor="acc-username" error={invite.fieldError("username")} hint="They sign in with this." required><Input id="acc-username" name="username" maxLength={32} autoComplete="off" disabled={demo} /></Field>
          <Field label="Email" htmlFor="acc-email" error={invite.fieldError("email")} hint="Optional: to email the sign-in link."><Input id="acc-email" name="email" type="email" disabled={demo} /></Field>
          <Field label="Last day of access" htmlFor="acc-end" error={invite.fieldError("ends_on")} hint="Access ends by itself at the end of this day."><DateInput id="acc-end" name="ends_on" min={today} defaultValue={defaultEnd} disabled={demo} /></Field>
        </div>
        <Checkbox name="payroll" label="Include driver payroll (approved pay periods and each driver's gross pay)" disabled={demo} />
        <p className="text-sm text-muted">They see invoices, payments, what is owed, hauler settlements and fuel/IFTA for any year, read-only, and can download them. Every visit is recorded.</p>
        <Button type="submit" loading={invite.pending} disabled={demo}>Create accountant sign-in</Button>
      </form>
    </div>
  );
}

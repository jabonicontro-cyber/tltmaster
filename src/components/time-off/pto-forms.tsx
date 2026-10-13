"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { ACCRUAL_METHODS, EMPLOYMENT_TYPES, PAY_PERIODS, type PtoBank } from "@/lib/pto";
import { TIME_OFF_CATEGORIES } from "@/lib/time-off";
import { adjustBalance, endPolicy, recordHours, runAccruals, saveBank, savePolicy } from "@/app/(app)/time-off/actions";
import { useFormAction } from "@/components/ui/use-form-action";

/** Create a bank, or edit one (time_off.balances). Amounts are never part of a bank: hours come from grants. */
export function BankForm({ bank, onDone }: { bank?: PtoBank; onDone?: () => void }) {
  const router = useRouter();
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveBank, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      onDone?.();
      router.refresh();
    },
  });
  const id = (n: string) => `bank-${bank?.id ?? "new"}-${n}`;
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-6" noValidate data-guard-unsaved>
      {bank && <input type="hidden" name="id" value={bank.id} />}
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Bank name" htmlFor={id("name")} required error={fieldError("name")} className="sm:col-span-4" hint="For example Paid time off, or Sick leave.">
        <Input id={id("name")} name="name" defaultValue={bank?.name ?? ""} maxLength={60} {...describedBy(id("name"), fieldError("name"), true)} />
      </Field>
      <Field label="Waiting period (days)" htmlFor={id("waiting_days")} error={fieldError("waiting_days")} className="sm:col-span-2" hint="From the hire date. 0 = none.">
        <Input id={id("waiting_days")} name="waiting_days" type="number" min={0} max={730} defaultValue={bank?.waiting_days ?? 0} inputMode="numeric" />
      </Field>
      <fieldset className="sm:col-span-6">
        <legend className="mb-1 text-sm font-semibold text-ink">Kinds of time off that draw from this bank</legend>
        <p className="mb-2 text-xs text-muted">One bank per kind; choose several for a combined bank.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {Object.entries(TIME_OFF_CATEGORIES).map(([v, l]) => (
            <Checkbox key={v} name="categories" value={v} label={l} defaultChecked={bank?.categories.includes(v as never) ?? false} />
          ))}
        </div>
        {fieldError("categories") && <p className="mt-1 text-sm text-red-700" role="alert">{fieldError("categories")}</p>}
      </fieldset>
      <fieldset className="sm:col-span-6">
        <legend className="mb-1 text-sm font-semibold text-ink">Who can use it</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {Object.entries(EMPLOYMENT_TYPES).map(([v, l]) => (
            <Checkbox key={v} name="employment_types" value={v} label={l} defaultChecked={bank?.employment_types.includes(v as never) ?? false} />
          ))}
        </div>
        {fieldError("employment_types") && <p className="mt-1 text-sm text-red-700" role="alert">{fieldError("employment_types")}</p>}
      </fieldset>
      {bank && (
        <Field label="Status" htmlFor={id("active")} className="sm:col-span-2" hint="An inactive bank keeps its history; its kinds of time off are no longer checked.">
          <Select id={id("active")} name="active" defaultValue={bank.active ? "true" : "false"}>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
        </Field>
      )}
      <div className="sm:col-span-6"><Button type="submit" loading={pending}>{bank ? "Save bank" : "Create bank"}</Button></div>
    </form>
  );
}

/** Grant hours or adjust a balance with a reason (time_off.balances). */
export function AdjustForm({ employees, banks }: { employees: Array<{ id: string; full_name: string }>; banks: PtoBank[] }) {
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<"grant" | "adjustment">("grant");
  const { pending, onSubmit, fieldError, formError } = useFormAction(adjustBalance, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setKey((k) => k + 1);
      setSubmissionKey(crypto.randomUUID());
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `adj-${name}`, name, ...describedBy(`adj-${name}`, fieldError(name)) });
  return (
    <form key={key} onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-6" noValidate data-guard-unsaved>
      <input type="hidden" name="submission_key" value={submissionKey} />
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Employee" htmlFor="adj-employee_id" required error={fieldError("employee_id")} className="sm:col-span-3">
        <Select {...f("employee_id")} defaultValue="">
          <option value="">Choose an employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </Select>
      </Field>
      <Field label="Bank" htmlFor="adj-bank_id" required error={fieldError("bank_id")} className="sm:col-span-3">
        <Select {...f("bank_id")} defaultValue={banks.length === 1 ? banks[0].id : ""}>
          {banks.length !== 1 && <option value="">Choose a bank…</option>}
          {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </Field>
      <Field label="Entry" htmlFor="adj-kind" required error={fieldError("kind")} className="sm:col-span-2">
        <Select {...f("kind")} value={kind} onChange={(e) => setKind(e.target.value as "grant" | "adjustment")}>
          <option value="grant">Grant (adds hours)</option>
          <option value="adjustment">Adjustment (+ or −)</option>
        </Select>
      </Field>
      <Field label="Hours" htmlFor="adj-hours" required error={fieldError("hours")} className="sm:col-span-2" hint={kind === "adjustment" ? "Use a minus sign to remove hours." : undefined}>
        <Input {...f("hours")} inputMode="decimal" placeholder={kind === "grant" ? "40" : "-4"} />
      </Field>
      <Field label="Dated" htmlFor="adj-effective_on" error={fieldError("effective_on")} className="sm:col-span-2" hint="Empty = today. Never in the future.">
        <DateInput {...f("effective_on")} />
      </Field>
      <Field label={kind === "adjustment" ? "Reason" : "Note (optional)"} htmlFor="adj-note" required={kind === "adjustment"} error={fieldError("note")} className="sm:col-span-6" hint="Kept in the balance history; the employee sees it.">
        <Textarea {...f("note")} rows={2} maxLength={500} />
      </Field>
      <div className="sm:col-span-6"><Button type="submit" loading={pending}>{kind === "grant" ? "Grant hours" : "Adjust balance"}</Button></div>
    </form>
  );
}

/** How a bank earns hours for one employment type (time_off.balances). Nothing is assumed: every value is entered. */
export function PolicyForm({ banks }: { banks: PtoBank[] }) {
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [method, setMethod] = useState<"annual_grant" | "hours_worked" | "per_pay_period">("annual_grant");
  const [carryover, setCarryover] = useState<"unlimited" | "capped">("unlimited");
  const { pending, onSubmit, fieldError, formError } = useFormAction(savePolicy, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setKey((k) => k + 1);
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `pol-${name}`, name, ...describedBy(`pol-${name}`, fieldError(name)) });
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return (
    <form key={key} onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-6" noValidate data-guard-unsaved>
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Bank" htmlFor="pol-bank_id" required error={fieldError("bank_id")} className="sm:col-span-2">
        <Select {...f("bank_id")} defaultValue={banks.length === 1 ? banks[0].id : ""}>
          {banks.length !== 1 && <option value="">Choose a bank…</option>}
          {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </Field>
      <Field label="Employment type" htmlFor="pol-employment_type" required error={fieldError("employment_type")} className="sm:col-span-2" hint="One policy per bank and type; saving replaces the current one.">
        <Select {...f("employment_type")} defaultValue="full_time">
          {Object.entries(EMPLOYMENT_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <Field label="How hours are earned" htmlFor="pol-method" required error={fieldError("method")} className="sm:col-span-2">
        <Select {...f("method")} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          {Object.entries(ACCRUAL_METHODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <Field label={method === "hours_worked" ? "Hours earned" : method === "annual_grant" ? "Hours each year" : "Hours each pay period"} htmlFor="pol-amount" required error={fieldError("amount")} className="sm:col-span-2">
        <Input {...f("amount")} inputMode="decimal" placeholder={method === "annual_grant" ? "80" : method === "hours_worked" ? "1" : "3.08"} />
      </Field>
      {method === "hours_worked" && (
        <Field label="Per hours worked" htmlFor="pol-per_hours" required error={fieldError("per_hours")} className="sm:col-span-2" hint="Hours come from Record hours worked (or an integration).">
          <Input {...f("per_hours")} inputMode="decimal" placeholder="30" />
        </Field>
      )}
      {method === "annual_grant" && (
        <>
          <Field label="Grant month" htmlFor="pol-grant_month" required error={fieldError("grant_month")} className="sm:col-span-2">
            <Select {...f("grant_month")} defaultValue="1">{months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>
          </Field>
          <Field label="Grant day" htmlFor="pol-grant_day" required className="sm:col-span-2" hint="1–28.">
            <Input {...f("grant_day")} type="number" min={1} max={28} defaultValue={1} />
          </Field>
        </>
      )}
      {method === "per_pay_period" && (
        <>
          <Field label="Pay period" htmlFor="pol-pay_period" required className="sm:col-span-2">
            <Select {...f("pay_period")} defaultValue="biweekly">{Object.entries(PAY_PERIODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          </Field>
          <Field label="First day of a pay period" htmlFor="pol-anchor_date" required error={fieldError("anchor_date")} className="sm:col-span-2">
            <DateInput {...f("anchor_date")} />
          </Field>
        </>
      )}
      <Field label="Maximum balance (optional)" htmlFor="pol-max_balance" error={fieldError("max_balance")} className="sm:col-span-2" hint="Accrual stops at this balance. Empty = no cap.">
        <Input {...f("max_balance")} inputMode="decimal" />
      </Field>
      <Field label="Policy starts" htmlFor="pol-effective_from" error={fieldError("effective_from")} className="sm:col-span-2" hint="Empty = today. Nothing earlier is posted.">
        <DateInput {...f("effective_from")} />
      </Field>
      <fieldset className="sm:col-span-6">
        <legend className="mb-1 text-sm font-semibold text-ink">At the start of each plan year</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="inline-flex items-center gap-2"><input type="radio" name="carryover" value="unlimited" checked={carryover === "unlimited"} onChange={() => setCarryover("unlimited")} className="accent-brand" />All hours carry over</label>
          <label className="inline-flex items-center gap-2"><input type="radio" name="carryover" value="capped" checked={carryover === "capped"} onChange={() => setCarryover("capped")} className="accent-brand" />Hours above a cap are forfeited</label>
        </div>
      </fieldset>
      {carryover === "capped" && (
        <>
          <Field label="Hours that carry over" htmlFor="pol-carryover_cap" required error={fieldError("carryover_cap")} className="sm:col-span-2" hint="0 = use it or lose it.">
            <Input {...f("carryover_cap")} inputMode="decimal" />
          </Field>
          <Field label="Plan year starts (month)" htmlFor="pol-plan_year_month" className="sm:col-span-2">
            <Select {...f("plan_year_month")} defaultValue="1">{months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>
          </Field>
          <Field label="Day" htmlFor="pol-plan_year_day" className="sm:col-span-2">
            <Input {...f("plan_year_day")} type="number" min={1} max={28} defaultValue={1} />
          </Field>
          <div className="sm:col-span-6">
            <Checkbox name="forfeiture_reviewed" label="We confirmed forfeiting earned hours is allowed where our employees work (it is not allowed everywhere)." />
            {fieldError("forfeiture_reviewed") && <p className="mt-1 text-sm text-red-700" role="alert">{fieldError("forfeiture_reviewed")}</p>}
          </div>
        </>
      )}
      <div className="sm:col-span-6"><Button type="submit" loading={pending}>Save policy</Button></div>
    </form>
  );
}

/** Eligible hours worked for an employee and a period that has ended (basis of hours-worked accrual). */
export function HoursForm({ employees }: { employees: Array<{ id: string; full_name: string }> }) {
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const { pending, onSubmit, fieldError, formError } = useFormAction(recordHours, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Recorded.");
      setKey((k) => k + 1);
      setSubmissionKey(crypto.randomUUID());
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `hrs-${name}`, name, ...describedBy(`hrs-${name}`, fieldError(name)) });
  return (
    <form key={key} onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-6" noValidate data-guard-unsaved>
      <input type="hidden" name="submission_key" value={submissionKey} />
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Employee" htmlFor="hrs-employee_id" required error={fieldError("employee_id")} className="sm:col-span-6">
        <Select {...f("employee_id")} defaultValue="">
          <option value="">Choose an employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </Select>
      </Field>
      <Field label="From" htmlFor="hrs-period_start" required error={fieldError("period_start")} className="sm:col-span-2"><DateInput {...f("period_start")} /></Field>
      <Field label="To" htmlFor="hrs-period_end" required error={fieldError("period_end")} className="sm:col-span-2"><DateInput {...f("period_end")} /></Field>
      <Field label="Hours worked" htmlFor="hrs-hours" required error={fieldError("hours")} className="sm:col-span-2"><Input {...f("hours")} inputMode="decimal" placeholder="40" /></Field>
      <div className="sm:col-span-6"><Button type="submit" variant="secondary" loading={pending}>Record hours</Button></div>
    </form>
  );
}

/** Post every accrual and plan-year forfeiture due through today, once (time_off.balances). */
export function RunAccrualsButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button loading={pending} onClick={() => start(async () => {
      const r = await runAccruals();
      if (!r.ok) toast.error(r.error);
      else { toast.success(r.message ?? "Done."); router.refresh(); }
    })}>Run accruals through today</Button>
  );
}

export function EndPolicyButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
      if (!window.confirm("Turn this policy off? Hours already earned stay; nothing new is posted.")) return;
      start(async () => {
        const r = await endPolicy(id);
        if (!r.ok) toast.error(r.error);
        else { toast.success(r.message ?? "Done."); router.refresh(); }
      });
    }}>Turn off</Button>
  );
}

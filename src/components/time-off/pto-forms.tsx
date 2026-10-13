"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { EMPLOYMENT_TYPES, type PtoBank } from "@/lib/pto";
import { TIME_OFF_CATEGORIES } from "@/lib/time-off";
import { adjustBalance, saveBank } from "@/app/(app)/time-off/actions";
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

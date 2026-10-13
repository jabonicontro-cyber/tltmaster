"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { TIME_OFF_CATEGORIES } from "@/lib/time-off";
import { submitTimeOff } from "@/app/(app)/time-off/actions";

/** Request time off for yourself, or (approvers) enter it for an employee. */
export function TimeOffForm({ employees, ownEmployeeId, bankFor = {} }: {
  employees: Array<{ id: string; full_name: string }> | null;
  ownEmployeeId: string | null;
  /** Kinds of time off that draw from a PTO bank, with the caller's own available hours when known. */
  bankFor?: Record<string, { name: string; available: number | null }>;
}) {
  const [category, setCategory] = useState("vacation");
  const bank = bankFor[category];
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<"full" | "partial">("full");
  const { pending, onSubmit, fieldError, formError } = useFormAction(submitTimeOff, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Sent.");
      setKey((k) => k + 1);
      setSubmissionKey(crypto.randomUUID());
      setKind("full");
      setCategory("vacation");
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `to-${name}`, name, ...describedBy(`to-${name}`, fieldError(name)) });
  return (
    <form key={key} data-guard-unsaved onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-6" noValidate>
      <input type="hidden" name="submission_key" value={submissionKey} />
      <input type="hidden" name="day_kind" value={kind} />
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      {employees && (
        <Field label="Employee" htmlFor="to-employee_id" error={fieldError("employee_id")} className="sm:col-span-3" hint="Approvers can enter time off for anyone, for example drivers without a login.">
          <Select {...f("employee_id")} defaultValue={ownEmployeeId ?? ""}>
            {!ownEmployeeId && <option value="">Choose an employee…</option>}
            {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}{e.id === ownEmployeeId ? " (you)" : ""}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Category" htmlFor="to-category" required error={fieldError("category")} className={employees ? "sm:col-span-3" : "sm:col-span-2"}>
        <Select {...f("category")} value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(TIME_OFF_CATEGORIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      </Field>
      <fieldset className="sm:col-span-6">
        <legend className="mb-1 text-sm font-semibold text-ink">Length</legend>
        <div className="flex gap-4 text-sm">
          <label className="inline-flex items-center gap-2"><input type="radio" name="day_kind_choice" checked={kind === "full"} onChange={() => setKind("full")} className="accent-brand" />Full day(s)</label>
          <label className="inline-flex items-center gap-2"><input type="radio" name="day_kind_choice" checked={kind === "partial"} onChange={() => setKind("partial")} className="accent-brand" />Part of a day</label>
        </div>
      </fieldset>
      <Field label={kind === "full" ? "First day" : "Date"} htmlFor="to-start_date" required error={fieldError("start_date")} className="sm:col-span-2">
        <DateInput {...f("start_date")} />
      </Field>
      {kind === "full" ? (
        <Field label="Last day" htmlFor="to-end_date" error={fieldError("end_date")} className="sm:col-span-2" hint="Leave empty for a single day.">
          <DateInput {...f("end_date")} />
        </Field>
      ) : (
        <>
          <Field label="From" htmlFor="to-start_time" required error={fieldError("start_time")} className="sm:col-span-2">
            <Input {...f("start_time")} type="time" />
          </Field>
          <Field label="To" htmlFor="to-end_time" required error={fieldError("end_time")} className="sm:col-span-2">
            <Input {...f("end_time")} type="time" />
          </Field>
        </>
      )}
      {bank && kind === "full" && (
        <Field label={`Hours of ${bank.name}`} htmlFor="to-hours" required error={fieldError("hours")} className="sm:col-span-2"
          hint={bank.available !== null && !employees ? `${Number(bank.available.toFixed(2))} h of your ${bank.name} available.` : `Draws from ${bank.name}; a request above the available hours is refused.`}>
          <Input {...f("hours")} inputMode="decimal" placeholder="8" />
        </Field>
      )}
      {bank && kind === "partial" && <p className="text-sm text-muted sm:col-span-6">The hours between the start and end time are taken from {bank.name}.</p>}
      <Field label="Comment (optional)" htmlFor="to-reason" error={fieldError("reason")} className="sm:col-span-6" hint="Visible to you and to people who manage time off — never to dispatch.">
        <Textarea {...f("reason")} rows={2} maxLength={1000} />
      </Field>
      <div className="sm:col-span-6"><Button type="submit" loading={pending}>Send request</Button></div>
    </form>
  );
}

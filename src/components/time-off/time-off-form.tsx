"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { TIME_OFF_CATEGORIES, hoursBetween, hoursShort, scheduleSummary, scheduledHours, usesText, type WeekHours } from "@/lib/time-off";
import { submitTimeOff } from "@/app/(app)/time-off/actions";

/** Request time off for yourself, or (approvers) enter it for an employee. */
export function TimeOffForm({ employees, ownEmployeeId, bankFor = {}, schedule = null }: {
  employees: Array<{ id: string; full_name: string }> | null;
  ownEmployeeId: string | null;
  /** Kinds of time off that draw from a PTO bank, with the caller's own available hours when known. */
  bankFor?: Record<string, { name: string; available: number | null }>;
  /** The caller's own work schedule (full days use its hours); null when none is recorded or it cannot be read. */
  schedule?: WeekHours | null;
}) {
  const [category, setCategory] = useState("vacation");
  const bank = bankFor[category];
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<"full" | "partial">("full");
  // What the request uses, shown before sending (own requests only: an approver may enter anyone's).
  const [v, setV] = useState({ start: "", end: "", from: "", to: "", hours: "" });
  const own = !employees;
  const sched = own && schedule && scheduleSummary(schedule) ? schedule : null;
  const typed = /^\d{1,4}(\.\d{1,2})?$/.test(v.hours.trim()) ? Number(v.hours) : null;
  const uses = kind === "partial" ? hoursBetween(v.from, v.to) : sched ? (v.start ? scheduledHours(sched, v.start, v.end || v.start) : null) : typed;
  const usesLine = bank && own ? usesText(uses, bank.available, bank.name) : null;
  const { pending, onSubmit, fieldError, formError } = useFormAction(submitTimeOff, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Sent.");
      setKey((k) => k + 1);
      setSubmissionKey(crypto.randomUUID());
      setKind("full");
      setCategory("vacation");
      setV({ start: "", end: "", from: "", to: "", hours: "" });
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
        <DateInput {...f("start_date")} onChange={(e) => setV((x) => ({ ...x, start: e.target.value }))} />
      </Field>
      {kind === "full" ? (
        <Field label="Last day" htmlFor="to-end_date" error={fieldError("end_date")} className="sm:col-span-2" hint="Leave empty for a single day.">
          <DateInput {...f("end_date")} onChange={(e) => setV((x) => ({ ...x, end: e.target.value }))} />
        </Field>
      ) : (
        <>
          <Field label="From" htmlFor="to-start_time" required error={fieldError("start_time")} className="sm:col-span-2">
            <Input {...f("start_time")} type="time" onChange={(e) => setV((x) => ({ ...x, from: e.target.value }))} />
          </Field>
          <Field label="To" htmlFor="to-end_time" required error={fieldError("end_time")} className="sm:col-span-2">
            <Input {...f("end_time")} type="time" onChange={(e) => setV((x) => ({ ...x, to: e.target.value }))} />
          </Field>
        </>
      )}
      {bank && kind === "full" && own && sched && (
        // The database uses the work schedule's hours for an employee's own full-day request: no field to type.
        <p className="text-sm text-muted sm:col-span-6" data-testid="schedule-hours">Hours come from your work schedule ({scheduleSummary(sched)}). Days without scheduled hours count as 0 h.</p>
      )}
      {bank && kind === "full" && !(own && sched) && (
        <Field label={`Hours of ${bank.name}`} htmlFor="to-hours" error={fieldError("hours")} className="sm:col-span-3"
          hint={own
            ? `${bank.available !== null ? `${hoursShort(bank.available, true)} of your ${bank.name} available. ` : ""}No work schedule is on record for you, so enter the hours these days use (for example 8 for one 8-hour day).`
            : `Draws from ${bank.name}. With a work schedule the scheduled hours of these days are used (enter hours only to correct them); without one, enter the hours.`}>
          <Input {...f("hours")} inputMode="decimal" placeholder={own ? undefined : "8"} onChange={(e) => setV((x) => ({ ...x, hours: e.target.value }))} />
        </Field>
      )}
      {usesLine && <p className="text-sm font-semibold text-ink sm:col-span-6" role="status" data-testid="uses-hours">{usesLine}</p>}
      {bank && kind === "partial" && <p className="text-sm text-muted sm:col-span-6">The hours between the start and end time are taken from {bank.name}.</p>}
      <Field label="Comment (optional)" htmlFor="to-reason" error={fieldError("reason")} className="sm:col-span-6" hint="Visible to you and to people who manage time off. Never to dispatch.">
        <Textarea {...f("reason")} rows={2} maxLength={1000} />
      </Field>
      <div className="sm:col-span-6"><Button type="submit" loading={pending}>Send request</Button></div>
    </form>
  );
}

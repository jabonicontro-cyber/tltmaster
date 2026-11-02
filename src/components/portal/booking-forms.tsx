"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/dates";
import type { CapacityDay } from "@/lib/portal-booking";
import { cn } from "@/lib/cn";
import { decideBooking, saveBookingSettings, setBookingCapacity } from "@/app/(app)/customer-portal/actions";

function useRefreshing(action: (fd: FormData) => Promise<ActionResult>) {
  const router = useRouter();
  return useFormAction(action, { onSuccess: (r) => { if (r.message) toast.success(r.message); router.refresh(); } });
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

export function BookingSettingsForm({ enabled, minDays, horizon, canEdit }: { enabled: boolean; minDays: number; horizon: number; canEdit: boolean }) {
  const { pending, onSubmit, formError } = useRefreshing(saveBookingSettings);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormError message={formError} />
      <fieldset disabled={!canEdit} className="space-y-4">
        <Checkbox name="enabled" defaultChecked={enabled} label="Customers can request loads in the portal" />
        <div className="flex flex-wrap gap-4">
          <Field label="Earliest day (days ahead)" htmlFor="bk-min"><Input id="bk-min" name="min_days_ahead" type="number" min={0} max={30} defaultValue={minDays} className="max-w-28" /></Field>
          <Field label="Latest day (days ahead)" htmlFor="bk-max"><Input id="bk-max" name="horizon_days" type="number" min={1} max={60} defaultValue={horizon} className="max-w-28" /></Field>
        </div>
      </fieldset>
      {canEdit ? <Button type="submit" loading={pending}>Save</Button> : <p className="text-sm text-muted">Only people who manage company settings can change this.</p>}
    </form>
  );
}

export function CapacityForm({ days, canEdit }: { days: CapacityDay[]; canEdit: boolean }) {
  const { pending, onSubmit, formError } = useRefreshing(setBookingCapacity);
  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Open loads per day">
      <FormError message={formError} />
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {days.map((d) => {
          const full = d.open !== null && d.taken >= d.open && d.open > 0;
          return (
            <li key={d.day} className={cn("rounded-xl border border-line bg-card p-2.5", full && "border-amber-500/60")}>
              <input type="hidden" name="day" value={d.day} />
              <input type="hidden" name="before" value={d.open === null ? "" : String(d.open)} />
              <label htmlFor={`cap-${d.day}`} className="block text-xs font-semibold text-muted">{WEEKDAY.format(new Date(`${d.day}T12:00:00Z`))} {formatDate(d.day)}</label>
              <Input id={`cap-${d.day}`} name="loads" type="number" min={0} max={500} placeholder="Closed" defaultValue={d.open ?? ""} disabled={!canEdit} className="mt-1 h-9" />
              <p className={cn("mt-1 text-xs tabular", full ? "font-semibold text-amber-800" : "text-muted")}>{d.taken} requested{full ? " · full" : ""}</p>
            </li>
          );
        })}
      </ul>
      {canEdit && <Button type="submit" loading={pending}>Save open loads</Button>}
    </form>
  );
}

export function BookingDecision({ request, status, orders }: { request: string; status: "pending" | "approved"; orders: Array<{ id: string; number: string }> }) {
  const approve = useRefreshing(decideBooking);
  const decline = useRefreshing(decideBooking);
  const [declining, setDeclining] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <FormError message={approve.formError ?? decline.formError} />
      <form onSubmit={approve.onSubmit} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="request" value={request} />
        <input type="hidden" name="status" value="approved" />
        {orders.length > 0 && (
          <Field label="Order" htmlFor={`bo-${request}`}>
            <Select id={`bo-${request}`} name="order" defaultValue="" className="h-9">
              <option value="">{status === "approved" ? "Link an order…" : "No order yet"}</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{o.number}</option>)}
            </Select>
          </Field>
        )}
        <Button type="submit" size="sm" variant={status === "pending" ? "primary" : "secondary"} loading={approve.pending}>{status === "pending" ? "Approve" : "Link order"}</Button>
      </form>
      {status === "pending" && (declining ? (
        <form onSubmit={decline.onSubmit} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="request" value={request} />
          <input type="hidden" name="status" value="declined" />
          <Field label="Reason (the customer sees it)" htmlFor={`bd-${request}`}><Input id={`bd-${request}`} name="note" required maxLength={1000} className="h-9" /></Field>
          <Button type="submit" size="sm" variant="secondary" loading={decline.pending}>Decline</Button>
        </form>
      ) : (
        <Button type="button" size="sm" variant="secondary" onClick={() => setDeclining(true)}>Decline…</Button>
      ))}
    </div>
  );
}

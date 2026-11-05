"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDate } from "@/lib/dates";
import { cancelBooking, requestBooking } from "@/app/portal/actions";

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const dayLabel = (d: string) => `${WEEKDAY.format(new Date(`${d}T12:00:00Z`))}, ${formatDate(d)}`;

/** Customer side of self-booking (B115): pick an open day, how many loads and what; the company approves it. */
export function BookingRequestForm({ slug, days, sites }: { slug: string; days: Array<{ day: string; open: boolean }>; sites: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const { pending, onSubmit, formError } = useFormAction(requestBooking, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Request sent.");
      form.current?.reset();
      router.refresh();
    },
  });
  const open = days.filter((d) => d.open);
  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-4" aria-label="Book loads">
      <FormError message={formError} />
      <input type="hidden" name="slug" value={slug} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Day" htmlFor="bk-day" required>
          <Select id="bk-day" name="day" required defaultValue={open[0]?.day ?? ""}>
            {days.map((d) => (
              <option key={d.day} value={d.day} disabled={!d.open}>{dayLabel(d.day)}{d.open ? "" : ", full"}</option>
            ))}
          </Select>
        </Field>
        <Field label="Loads" htmlFor="bk-loads" required>
          <Input id="bk-loads" name="loads" type="number" min={1} max={100} defaultValue={1} required />
        </Field>
        <Field label="Time of day" htmlFor="bk-window">
          <Select id="bk-window" name="time_window" defaultValue="any">
            <option value="any">Any time</option>
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
          </Select>
        </Field>
      </div>
      <Field label="What do you need hauled?" htmlFor="bk-material" required>
        <Input id="bk-material" name="material" required maxLength={200} placeholder="e.g. Base rock, fill dirt" />
      </Field>
      {sites.length > 0 && (
        <Field label="Job site" htmlFor="bk-site">
          <Select id="bk-site" name="site_id" defaultValue="">
            <option value="">Tell us in the notes</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Notes" htmlFor="bk-notes">
        <Textarea id="bk-notes" name="notes" rows={3} maxLength={2000} />
      </Field>
      <Button type="submit" loading={pending} disabled={!open.length}>Send request</Button>
    </form>
  );
}

export function CancelBookingButton({ slug, request }: { slug: string; request: string }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(cancelBooking, { onSuccess: (r) => { toast.success(r.message ?? "Withdrawn."); router.refresh(); } });
  return (
    <form onSubmit={onSubmit}>
      <FormError message={formError} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="request" value={request} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>Withdraw</Button>
    </form>
  );
}

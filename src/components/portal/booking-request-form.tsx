"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
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
          {/* One job site on file: it is the one (UX day-1); "Tell us in the notes" stays available for a new site. */}
          <Select id="bk-site" name="site_id" defaultValue={sites.length === 1 ? sites[0].id : ""}>
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

/**
 * Withdraw a request still waiting for an answer. It asks first (portal walkthrough WK1: one tap withdrew it): the
 * request cannot be brought back, only sent again.
 */
export function CancelBookingButton({ slug, request, summary }: { slug: string; request: string; summary?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>Withdraw</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Withdraw this request?"
        description={`${summary ? `${summary}. ` : ""}The company will not schedule it. To ask again later, send a new request.`}
        confirmLabel="Withdraw request"
        tone="danger"
        onConfirm={async () => {
          const data = new FormData();
          data.set("slug", slug);
          data.set("request", request);
          const r = await cancelBooking(data);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Withdrawn.");
          router.refresh();
        }}
      />
    </>
  );
}

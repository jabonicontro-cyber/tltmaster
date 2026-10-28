"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { cancelShiftOffer, createShiftOffer, decideShiftOffer, respondShiftOffer, saveShiftOfferMode, withdrawShiftOffer } from "@/app/(app)/schedule/offer-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/dates";
import { AUDIENCE_LABEL, OFFER_MODES, OFFER_STATUS, RESPONSE_LABEL, modeLabel, respondLabel, type OfferAudience, type OfferMode } from "@/lib/schedule/offers";
import { clockTime } from "@/lib/schedule/shifts";
import type { MyShiftOffer, ShiftOffer } from "@/server/data/shift-offers";

// Shift offers (B102): planners offer a shift on the Schedule; people answer on My Day; the company picks the mode in
// Settings. Every button calls a server action that the database checks again.

function useAction(action: (f: FormData) => Promise<ActionResult>, done?: () => void) {
  const router = useRouter();
  return useFormAction(action, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      done?.();
      router.refresh();
    },
  });
}

const when = (o: { workDate: string; start: string; end: string; breakMinutes: number }) =>
  `${formatDate(o.workDate)}, ${clockTime(o.start)}–${clockTime(o.end)}${o.breakMinutes ? ` (${o.breakMinutes} min break)` : ""}`;

export interface OfferPerson { id: string; name: string; driver: boolean; shop: boolean }

/** Offer a shift (planners). In the "offer" mode the planner also picks who it goes to. */
export function OfferShiftButton({ mode, people, today }: { mode: OfferMode; people: OfferPerson[]; today: string }) {
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState<OfferAudience>("drivers");
  const { pending, onSubmit, formError } = useAction(createShiftOffer, () => setOpen(false));
  const choosable = people.filter((p) => audience === "everyone" || (audience === "drivers" ? p.driver : p.shop));
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Offer a shift</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Offer a shift" description={modeLabel(mode) + ". Change this in Settings → Shift offers."} size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate aria-label="Offer a shift">
          <FormError message={formError} />
          <Field label="Date" htmlFor="so-date" required><DateInput id="so-date" name="date" min={today} required /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Start" htmlFor="so-start" required><Input id="so-start" name="start" type="time" defaultValue="06:00" required /></Field>
            <Field label="End" htmlFor="so-end" required><Input id="so-end" name="end" type="time" defaultValue="14:30" required /></Field>
            <Field label="Break (min)" htmlFor="so-break"><Input id="so-break" name="break" inputMode="numeric" defaultValue="30" /></Field>
          </div>
          <Field label="For" htmlFor="so-audience">
            <Select id="so-audience" name="audience" value={audience} onChange={(e) => setAudience(e.target.value as OfferAudience)}>
              {(Object.keys(AUDIENCE_LABEL) as OfferAudience[]).map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
            </Select>
          </Field>
          {mode === "offer" && (
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-sm font-medium">Offer to</legend>
              {choosable.length === 0 ? <p className="text-sm text-muted">Nobody in this group.</p> : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-control border border-line p-2">
                  {choosable.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="target" value={p.id} className="size-4 accent-brand" /> {p.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          )}
          <Field label="Note" htmlFor="so-note" hint="What the shift is for"><Input id="so-note" name="note" maxLength={300} /></Field>
          <Button type="submit" loading={pending}>Offer shift</Button>
        </form>
      </Dialog>
    </>
  );
}

function DecideButtons({ responseId, name, confirm }: { responseId: string; name: string; confirm: boolean }) {
  const approve = useAction(decideShiftOffer);
  const decline = useAction(decideShiftOffer);
  return (
    <span className="inline-flex flex-wrap gap-1">
      <form onSubmit={approve.onSubmit}>
        <input type="hidden" name="response" value={responseId} />
        <input type="hidden" name="decision" value="approve" />
        <Button type="submit" size="sm" loading={approve.pending} aria-label={`${confirm ? "Confirm" : "Approve"} ${name}`}>{confirm ? "Confirm" : "Approve"}</Button>
      </form>
      <form onSubmit={decline.onSubmit}>
        <input type="hidden" name="response" value={responseId} />
        <input type="hidden" name="decision" value="decline" />
        <Button type="submit" size="sm" variant="ghost" loading={decline.pending} aria-label={`Decline ${name}`}>Decline</Button>
      </form>
      <FormError message={approve.formError ?? decline.formError} />
    </span>
  );
}

function CancelOffer({ offerId }: { offerId: string }) {
  const [open, setOpen] = useState(false);
  const { pending, onSubmit, formError } = useAction(cancelShiftOffer, () => setOpen(false));
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Withdraw offer</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Withdraw this shift offer" description="Anyone who asked or accepted is told it is no longer needed." size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <input type="hidden" name="offer" value={offerId} />
          <FormError message={formError} />
          <Field label="Reason" htmlFor={`so-cancel-${offerId}`} required><Input id={`so-cancel-${offerId}`} name="reason" maxLength={300} required /></Field>
          <Button type="submit" variant="danger" loading={pending}>Withdraw offer</Button>
        </form>
      </Dialog>
    </>
  );
}

/** The company's shift offers on the Schedule: open ones first, with who answered and the planner's buttons. */
export function ShiftOffersList({ offers, names, canManage }: { offers: ShiftOffer[]; names: Record<string, string>; canManage: boolean }) {
  return (
    <ul className="divide-y divide-line border-t border-line" aria-label="Shift offers">
      {offers.map((o) => {
        const st = OFFER_STATUS[o.status];
        const live = o.status === "open" || o.status === "pending";
        const waiting = o.responses.filter((r) => r.status === "requested" || r.status === "accepted");
        return (
          <li key={o.id} id={`offer-${o.id}`} className="px-5 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold">{when(o)}</span>
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="text-sm text-muted">{AUDIENCE_LABEL[o.audience]} · {modeLabel(o.mode)}</span>
              {canManage && live && <span className="ml-auto"><CancelOffer offerId={o.id} /></span>}
            </div>
            {o.note && <p className="mt-0.5 text-sm text-muted">{o.note}</p>}
            {o.status === "filled" && o.filledEmployee && <p className="mt-1 text-sm">Filled by <span className="font-medium">{names[o.filledEmployee] ?? "a former employee"}</span></p>}
            {o.status === "canceled" && o.cancelReason && <p className="mt-1 text-sm text-muted">Withdrawn: {o.cancelReason}</p>}
            {o.mode === "offer" && o.targets.length > 0 && live && (
              <p className="mt-1 text-sm text-muted">Offered to {o.targets.map((t) => names[t] ?? "someone").join(", ")}</p>
            )}
            {live && (waiting.length ? (
              <ul className="mt-2 space-y-1.5" aria-label="Answers">
                {waiting.map((r) => {
                  const name = names[r.employeeId] ?? "Someone";
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{name}</span>
                      <span className="text-muted">{RESPONSE_LABEL[r.status]}</span>
                      {canManage && <DecideButtons responseId={r.id} name={name} confirm={r.status === "accepted"} />}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="mt-1 text-sm text-muted">No answers yet.</p>)}
          </li>
        );
      })}
    </ul>
  );
}

function RespondButton({ offer }: { offer: MyShiftOffer }) {
  const respond = useAction(respondShiftOffer);
  const withdraw = useAction(withdrawShiftOffer);
  if (offer.myStatus === "requested" || offer.myStatus === "accepted") {
    return (
      <form onSubmit={withdraw.onSubmit} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="offer" value={offer.id} />
        <Badge tone="amber">{offer.myStatus === "requested" ? "Asked — waiting" : "Accepted — waiting"}</Badge>
        <Button type="submit" size="sm" variant="ghost" loading={withdraw.pending}>Withdraw</Button>
        <FormError message={withdraw.formError} />
      </form>
    );
  }
  if (offer.myStatus) return <Badge tone={offer.myStatus === "approved" ? "green" : "gray"}>{RESPONSE_LABEL[offer.myStatus]}</Badge>;
  return (
    <form onSubmit={respond.onSubmit} className="space-y-1">
      <input type="hidden" name="offer" value={offer.id} />
      <Button type="submit" size="sm" loading={respond.pending}>{respondLabel(offer.mode)}</Button>
      <FormError message={respond.formError} />
    </form>
  );
}

/** My Day: shifts offered to the person, with Ask / Accept / Withdraw. */
export function MyShiftOffers({ offers }: { offers: MyShiftOffer[] }) {
  return (
    <ul className="divide-y divide-line" aria-label="Open shifts">
      {offers.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="font-semibold">{when(o)}</p>
            {o.note && <p className="text-sm text-muted">{o.note}</p>}
          </div>
          <RespondButton offer={o} />
        </li>
      ))}
    </ul>
  );
}

/** Settings → Shift offers: how the company fills offered shifts. */
export function ShiftOfferModeForm({ mode, canEdit }: { mode: OfferMode; canEdit: boolean }) {
  const { pending, onSubmit, formError } = useAction(saveShiftOfferMode);
  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Shift offer mode">
      <FormError message={formError} />
      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="sr-only">How offered shifts are filled</legend>
        {OFFER_MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-3 rounded-control border border-line p-3 has-[:checked]:border-strong has-[:checked]:bg-surface">
            <input type="radio" name="mode" value={m.value} defaultChecked={m.value === mode} className="mt-1 size-4 accent-brand" />
            <span>
              <span className="block font-medium">{m.label}</span>
              <span className="block text-sm text-muted">{m.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {canEdit && <Button type="submit" loading={pending}>Save</Button>}
    </form>
  );
}

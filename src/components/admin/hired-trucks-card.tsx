import { Badge } from "@/components/ui/badge";
import { CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { setHiredTrucks } from "@/app/admin/companies/lifecycle-actions";

export type HiredTrucksEntitlement = { entitled: boolean; note: string };

/** Company page → Hired trucks (B83): an add-on the platform owner switches on per company (owner 2026-10-26). */
export function HiredTrucksCard({ companyId, state }: { companyId: string; state: HiredTrucksEntitlement }) {
  return (
    <section aria-label="Hired trucks add-on">
      <CardHeader
        title="Hired trucks"
        description="Owner-operators and subcontracted haulers: documents, offers, confirmation through dispatch, hauler pay. An add-on, not part of the base plans."
        actions={<Badge tone={state.entitled ? "green" : "gray"}>{state.entitled ? "On" : "Off"}</Badge>}
      />
      <CardBody>
        <form action={setHiredTrucks} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={companyId} />
          <input type="hidden" name="entitled" value={state.entitled ? "no" : "yes"} />
          <Field label="Note (why)" htmlFor="hired-note" className="min-w-64 flex-1">
            <Input id="hired-note" name="note" maxLength={500} defaultValue={state.note} />
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Saving…">{state.entitled ? "Switch Off" : "Switch On"}</SubmitButton>
        </form>
        {state.entitled ? <p className="mt-2 text-xs text-muted">Switching it off hides the page and stops new offers; haulers, documents and past offers are kept.</p> : null}
      </CardBody>
    </section>
  );
}

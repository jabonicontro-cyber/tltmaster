import { Badge } from "@/components/ui/badge";
import { CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { setPortalEntitlement } from "@/app/admin/companies/lifecycle-actions";

export type PortalEntitlement = { entitled: boolean; enabled: boolean; accounts: number; note: string };

/**
 * Company page → Customer Portal (B66). Whether the company may offer a portal is the platform owner's decision (which
 * plans include it is not decided yet, so it is set per company and never assumed). The company turns it on itself.
 */
export function PortalEntitlementCard({ companyId, state }: { companyId: string; state: PortalEntitlement }) {
  return (
    <section aria-label="Customer portal entitlement">
      <CardHeader
        title="Customer Portal"
        description="Lets this company offer its own customers a portal. Granting it does not turn the portal on or change billing; the company does that in its Customer Portal settings."
        actions={<Badge tone={state.entitled ? "green" : "gray"}>{state.entitled ? (state.enabled ? "Entitled · on" : "Entitled · off") : "Not entitled"}</Badge>}
      />
      <CardBody>
        <p className="mb-3 text-sm text-muted">{state.accounts} active customer {state.accounts === 1 ? "account" : "accounts"}.{state.note ? ` Note: ${state.note}` : ""}</p>
        <form action={setPortalEntitlement} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={companyId} />
          <input type="hidden" name="entitled" value={state.entitled ? "no" : "yes"} />
          <Field label="Note (why)" htmlFor="portal-note" className="min-w-64 flex-1">
            <Input id="portal-note" name="note" maxLength={500} defaultValue={state.note} />
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Saving…">{state.entitled ? "Remove Entitlement" : "Grant Entitlement"}</SubmitButton>
        </form>
        {state.entitled ? <p className="mt-2 text-xs text-muted">Removing it also turns the company&apos;s portal off; accounts and records are kept.</p> : null}
      </CardBody>
    </section>
  );
}

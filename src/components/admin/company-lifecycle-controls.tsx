import { Badge } from "@/components/ui/badge";
import { CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { archiveCompany, classifyCompany, deleteCompany, restoreCompany } from "@/app/admin/companies/lifecycle-actions";
import { COMPANY_CLASS_LABELS, type CompanyClass } from "@/lib/terminology";

export type DeletePreview = { name: string; classification: CompanyClass; archived_at: string | null; archive_reason: string; eligible: boolean; blockers: string[]; counts: Record<string, number>; members: number };

/**
 * Company page → Classification and Archive (B67). Classification is a person's decision (never inferred from a name
 * or an empty setup); archive is reversible; permanent delete shows exactly what would be removed and needs the
 * company name typed. Demo companies are managed in Demo Management.
 */
export function CompanyLifecycleControls({
  company,
  preview,
}: {
  company: { id: string; name: string; classification: CompanyClass; archived_at: string | null; archive_reason: string; is_demo: boolean };
  preview: DeletePreview | null;
}) {
  if (company.is_demo) return null;
  const archived = Boolean(company.archived_at);
  const total = preview ? Object.values(preview.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <section aria-label="Classification and archive">
      <CardHeader
        title="Classification and Archive"
        description="Mark practice or test companies yourself; nothing is classified automatically. Archived companies are hidden from the directory, customer counts, onboarding metrics and MRR, and their people cannot open them. Archiving keeps every record and can be undone."
      />
      <CardBody className="space-y-6">
        <form action={classifyCompany} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={company.id} />
          <Field label="Classification" htmlFor="classification">
            <select id="classification" name="classification" defaultValue={company.classification} className="h-10 rounded-md border border-line bg-card px-3 text-[15px] text-ink">
              {(Object.entries(COMPANY_CLASS_LABELS) as Array<[CompanyClass, string]>).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Saving…">Save Classification</SubmitButton>
        </form>

        {archived ? (
          <div className="space-y-3 border-t border-line pt-5">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>Archived</Badge>
              <span className="text-muted">Reason: {company.archive_reason || "—"}</span>
            </p>
            <form action={restoreCompany}>
              <input type="hidden" name="id" value={company.id} />
              <SubmitButton variant="secondary" pendingLabel="Restoring…">Restore Company</SubmitButton>
            </form>
          </div>
        ) : (
          <form action={archiveCompany} className="space-y-3 border-t border-line pt-5">
            <input type="hidden" name="id" value={company.id} />
            <Notice tone="warning" title="Before archiving">
              Its people lose access until it is restored, and it stops counting as a customer. Billing records and history are kept.
            </Notice>
            <Field label="Reason" htmlFor="archive-reason" required>
              <Input id="archive-reason" name="reason" required maxLength={500} placeholder="e.g. Practice company from onboarding training" />
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" required className="size-4 accent-brand" /> I understand its people lose access until it is restored</label>
            <SubmitButton variant="secondary" pendingLabel="Archiving…">Archive Company</SubmitButton>
          </form>
        )}

        {preview ? (
          <div className="space-y-3 border-t border-line pt-5">
            <h3 className="text-base font-semibold text-ink">Permanent Delete</h3>
            {!preview.eligible ? (
              <p className="text-sm text-muted">Only an archived company classified as Practice / test can be deleted. {preview.blockers.join(" ")}</p>
            ) : (
              <form action={deleteCompany} className="space-y-3">
                <input type="hidden" name="id" value={company.id} />
                <Notice tone="warning" title="This cannot be undone">
                  {total} records{preview.members ? ` and ${preview.members} memberships` : ""} will be removed. Sign-in accounts are kept (a person may belong to other companies). The deletion and these counts stay in the platform audit.
                </Notice>
                <ul className="grid gap-x-6 text-sm text-muted sm:grid-cols-2" aria-label="Records to delete">
                  {Object.entries(preview.counts).map(([k, n]) => (
                    <li key={k} className="flex justify-between gap-3 border-b border-line py-1"><span>{k.replace(/_/g, " ")}</span><span className="tabular">{n}</span></li>
                  ))}
                </ul>
                <Field label={`Type the company name (${preview.name}) to confirm`} htmlFor="confirm-name" required>
                  <Input id="confirm-name" name="confirm_name" required autoComplete="off" />
                </Field>
                <SubmitButton variant="danger" pendingLabel="Deleting…">Delete Permanently</SubmitButton>
              </form>
            )}
          </div>
        ) : null}
      </CardBody>
    </section>
  );
}

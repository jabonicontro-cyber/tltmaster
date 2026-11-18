import { Receipt } from "lucide-react";
import { chooseInvoiceIssuer } from "@/app/(app)/billing/invoices/actions";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import type { Issuer } from "@/server/data/invoices";

export const ISSUER_OPTIONS: ReadonlyArray<readonly [Issuer, string, string]> = [
  ["taviron", "Taviron", "You make, send and track invoices here, with your logo. Payments are recorded here too."],
  ["quickbooks", "QuickBooks", "Finished orders go to QuickBooks and you send the invoices from QuickBooks."],
];

/**
 * "Who sends your invoices: Taviron or QuickBooks?" (owner decision 2026-11-17, INV1). Shown in Getting started's step,
 * on Settings → Invoicing, and on the billing pages until the company answers. People who cannot change invoicing
 * (billing.manage) are told who decides instead of seeing empty QuickBooks screens.
 */
export function InvoicingChoice({ canChoose, back, current, asked = true, bare = false }: { canChoose: boolean; back: string; current?: Issuer | null; asked?: boolean; bare?: boolean }) {
  if (!canChoose) {
    return (
      <Notice title="Your company hasn't chosen who sends invoices yet">
        The owner chooses between Taviron and QuickBooks in Settings → Invoicing. Until then, the billing work list below still shows what is ready to bill.
      </Notice>
    );
  }
  const title = asked ? "Who sends your invoices: Taviron or QuickBooks?" : "Who sends your invoices";
  const description = asked ? "Choose one to set up billing. You can change it later in Settings → Invoicing." : "Invoices already sent keep how they were sent.";
  const form = (
        <form action={chooseInvoiceIssuer} className="max-w-xl space-y-3" aria-label="Who sends your invoices">
          <input type="hidden" name="back" value={back} />
          <fieldset className="space-y-2">
            <legend className="sr-only">Who sends your invoices</legend>
            {ISSUER_OPTIONS.map(([v, label, hint]) => (
              <label key={v} className="flex items-start gap-3 rounded-control border border-line p-3 has-[:checked]:border-strong has-[:checked]:bg-surface">
                <input type="radio" name="issuer" value={v} defaultChecked={current === v} required className="mt-1 size-4 accent-brand" />
                <span><span className="block font-medium">{label}</span><span className="block text-sm text-muted">{hint}</span></span>
              </label>
            ))}
          </fieldset>
          <SubmitButton><Receipt className="size-4" aria-hidden /> Save</SubmitButton>
        </form>
  );
  // Inside a card that is already there (Settings → Invoicing): the section only.
  if (bare) {
    return (
      <section id="issuer" data-testid="invoicing-choice" className="scroll-mt-20 space-y-3" aria-label={title}>
        <div>
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <p className="text-sm text-muted">{description}</p>
        </div>
        {form}
      </section>
    );
  }
  return (
    <div id="issuer" data-testid="invoicing-choice" className="scroll-mt-20">
      <Card>
        <CardHeader title={title} description={description} />
        <CardBody>{form}</CardBody>
      </Card>
    </div>
  );
}

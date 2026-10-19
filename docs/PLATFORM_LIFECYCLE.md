# Platform customer lifecycle (B53)

Migration `20261118000300_platform_lifecycle.sql` (rollback in `supabase/rollbacks/`, refuses while lifecycle data
exists). Platform admins only; every rule is enforced in the database functions, and the pages explain them.

## What is built

| Area | Behaviour |
| --- | --- |
| Console KPIs (Launchpad) | Four fixed tiles: customer companies live, monthly recurring revenue (sum of **agreed** monthly amounts of live companies; free beta counted as $0), pipeline (open leads), onboarding (fee due + onboarding). Without the migration each tile says so instead of showing 0. |
| Needs attention | **Acknowledge** records who and when (optional note); the item stays until its cause is resolved. An acknowledgement older than the problem's start does not apply, so a recurring problem shows as new. |
| Plans and prices (`/admin/plans`) | Versioned catalog. Version 1 = master plan §5.1 (Essential $499/$199, Growth $749/$299, Professional $999/$399, Enterprise from $1,499/$599, Custom quoted). A new price is a new version from today or later; companies keep the version they chose. The public pricing page (`src/lib/site/pricing.ts`) is not changed by it. |
| Subscription (company page) | Plan, terms (monthly / annual 12-month commitment at 10% off), offer (standard / founding 20% off / free beta: $0 and onboarding fee waived) and the **agreed monthly amount**. Taviron suggests it only where unambiguous; Custom, Enterprise ("from") and founding + annual need the amount typed (whether those discounts combine is the owner's decision). Founding terms exist only in this private platform data. |
| Onboarding fee | Recorded as received (with a reference) or waived (with a reason); then the company is Onboarding. |
| Go-live date | Set once while onboarding; afterwards it can only move **earlier**, never later or into the past (company time zone). |
| Go Live Now | The admin re-enters their password (`src/server/reauth.ts`: a separate, non-persisting sign-in); the database also requires a sign-in in the last 5 minutes. Idempotent. |
| Scheduled activation | `private.lifecycle_activate_due()` makes companies live on their go-live day; run when the console opens and daily by `/api/cron/lifecycle-activation` (`vercel.json`, CRON_SECRET; service role only). Idempotent. |
| Cancellation | An annual commitment states its remaining balance (monthly payments not yet due × agreed amount); the operator confirms that exact amount. Recorded only. |
| Audit | Every change goes to the platform audit and the company page's history. |

## Not built (needs the owner)

- **No payment provider is connected.** No checkout, card capture, invoices, charges, webhooks, failed-payment grace or
  access restriction exist. Those need the owner's provider choice and explicit authorization (CLAUDE.md), then signed
  webhooks with idempotent processing. Until then subscription access is never restricted by this feature.
- Top Line's free beta is one click on its company page (offer "Free beta"); it is not set automatically.
- Hosted: the owner applies `20261118000300` (`supabase db push`, DEPLOYMENT §2a). The cron route answers 503 until
  CRON_SECRET and the migration exist; the console still activates due companies when opened.

## Tests

`tests/db/platform-lifecycle.test.ts` (access, pricing rules, versions, fee → onboarding → earlier-only date → fresh
sign-in, idempotent activation and MRR, cancellation balance, acknowledgements), `tests/e2e/platform.spec.ts`
(lifecycle flow and Launchpad KPIs), `tests/e2e/cron.spec.ts` (secret required). Demo companies have no lifecycle.

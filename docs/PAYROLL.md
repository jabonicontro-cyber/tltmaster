# Driver payroll from delivery tickets

Master plan §12 row B27. Owner directives of 2026-10-18 ("Delivery-ticket-based driver payroll", "Payroll rules
discovery", "Company-specific earnings formula engine"). Last updated 2026-10-18.

## 1. What Taviron does, and what it does not

- **Does:** turns verified (accepted) delivery tickets into gross driver earnings with the company's own pay rules,
  per payroll period; flags every ticket it cannot pay; lets the payroll owner approve and lock a period; prepares an
  export and records what the destination did with it. Every amount can be traced to its ticket, rule version, inputs
  and calculation.
- **Does not:** invent a pay rule, pay from customer billing rates unless a rule names them, calculate taxes,
  withholding or net pay, remit anything, or post to QuickBooks. Nothing is calculated for a company until it has an
  active rule it approved **and** has turned calculation on.

## 2. Reused, not rebuilt

Delivery tickets (`public.delivery_tickets`) stay the only source of earnings: ticket number with duplicate checks,
revision history (`correct_delivery_ticket` supersedes the old revision), review status (submitted → needs review →
accepted / voided), driver, truck, order, material, quantity, unit, delivery time, reviewer, and paper-ticket photos
(`ticket_attachments`). Payroll reads them; it never edits a ticket.

## 3. Pieces

| Piece | Where |
| --- | --- |
| Formula engine (whitelisted inputs and operators, exact decimals, rounding, breakdown, rule selection) | `src/lib/payroll/formula.ts` |
| Server calculation (rules + tickets → entries or exceptions) | `src/server/payroll/calculate.ts` |
| Export files (neutral CSV; formula-injection safe) | `src/lib/payroll/export.ts` |
| Database: settings, rules and versions, periods, ledger, adjustments, exports; owner-only; audit | `supabase/migrations/20261118000200_driver_payroll.sql` (rollback in `supabase/rollbacks/`) |

### Formula language

Inputs: `quantity`, `tons` (tickets in tons only), `loads` (1 per ticket), `rate` (the rule's rate), `hours` (not
recorded on tickets today, so a formula using it always becomes an exception), `billed_amount` (the customer line rate ×
quantity, only when a formula names it), `driver_share` (1: a ticket has one driver). Operators `+ - * /`, parentheses,
`min()`, `max()`, `if(condition, value, otherwise)` with `< <= > >= == !=`. Examples (not policy):
`tons * rate`, `loads * rate`, `max(tons * rate, 60)`, `if(tons > 20, tons * 4, tons * 3.5)`.

Arithmetic is exact (integers scaled by 10^6); the result is rounded **once per ticket**, half away from zero, to cents.
A missing input, division by zero or an unknown word stops the calculation and names the problem.

### Rule selection

A rule version applies to a ticket when it is active, in effect on the ticket's business date (company time zone), for
the ticket's unit (if the rule names one), and every scope it names (driver, customer, order, material, truck) matches.
The most specific applies. Two equally specific rules are a **conflict** (an exception), never an arbitrary choice; two
active versions with the same scope and overlapping dates cannot be activated at all.

### Lifecycle

Ticket: submitted → needs review → accepted (payable) · voided · superseded by a correction.
Period: open → (in review) → approved (locked, totals stored) → exported → reconciled.
Ledger entry: calculated · exception → excluded (with reason) · reversed (kept in history).

- One live ledger entry per ticket and driver (database unique index): re-entry, retries and duplicate submissions
  cannot pay a ticket twice.
- Approval is refused while exceptions are unresolved.
- An approved period never changes. A ticket corrected or voided after approval is listed in the next period's
  **Corrections** and settled with an explicit adjustment (with reason) linked to the original entry.
- Adjustments (additions or deductions) are entered by a person with a reason. Nothing is deducted automatically.

### Access

Permission `payroll.manage`, granted to the **owner** role by default (Top Line's requirement: owner-only). Every table
is readable only with that permission in the caller's company; every change goes through a database function that checks
the permission, the company and the period state, and writes the audit log (`audit_events`, actions `payroll.*`).

### Export

`summary_csv` (per driver: tickets, ticket earnings, adjustments, gross) and `detail_csv` (per ticket with its
calculation). These are neutral files for the bookkeeper. They are **not** a verified QuickBooks Desktop, QuickBooks
Online or payroll-provider import: each destination's import format and employee/earnings-item mapping must be confirmed
and tested before production use. An export is recorded with its content hash (the same file is the same export), only
for an approved period, only when its total equals the approved total; the destination's outcome (accepted / rejected /
failed, reference) is recorded and an accepted export reconciles the period.

## 4. Payroll Rules Discovery Report (Top Line), 2026-10-18

**Source records examined: none were available.** This environment has no Top Line delivery-ticket images, payroll
registers, driver pay summaries, rate sheets, spreadsheets or project agreements; the hosted database is not reachable
from the development environment, and the repository holds only fictional test data. No pay rule is therefore inferred
or configured for Top Line.

Confirmed context (owner statements, not records): drivers are paid for work completed, not hours; tickets are
handwritten and submitted daily; tickets drive billing, pay and material tracking; payroll is owner-only; QuickBooks
Desktop today, QuickBooks Online expected by launch. The owner's first directive mentioned "delivered tons × a
project-specific rate per ton" as the expected method; the second directive asks that this be confirmed from records
before it is enabled.

**Records needed** (any 2–4 recent pay periods): photos or scans of the handwritten tickets (front and back), the
payroll register or driver pay summaries for the same periods, any rate sheet or notes showing pay rates by project,
customer, material, truck or driver, and examples of corrections, disputes or special pay.

**Owner decisions** (each to be recorded on the rule or setting it affects):

| Decision | Why it is needed |
| --- | --- |
| Rate basis: per ton, per load, per hour, % of billing, or a combination; and what a rate depends on (project, customer, material, truck, driver) | Determines the formula and the rule scopes |
| When a ticket becomes payable (accepted by the office today) | The payable status setting |
| Which source wins when ticket, rate sheet and payroll record disagree | Exceptions handling |
| Tonnage precision and rounding stage (Taviron rounds once per ticket today) | Reproducibility with historical payroll |
| Minimums, premiums, waiting time, reimbursements, deductions | Only if records show them; none are assumed |
| Pay period schedule, cutoff, late tickets | Period settings |
| Shared deliveries (two drivers on one load) | Tickets have one driver today; any split needs a rule |
| Who may verify tickets and approve payroll beyond the owner | Permissions |
| Payroll destination, import format and employee/earnings mapping (QuickBooks Desktop / Online / provider) | Export format |
| Minimum-wage, overtime and recordkeeping obligations for production-paid drivers in the relevant states | Legal review; Taviron does not decide these |

**Before enabling for Top Line:** configure the confirmed rule (status draft), compare its results against the historical
payroll for the sample periods and explain every difference, have the owner activate it, then turn calculation on.

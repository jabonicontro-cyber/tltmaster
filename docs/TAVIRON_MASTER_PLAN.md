# Taviron master plan

Last updated: 2026-10-11 (after N14). This file holds product direction and decisions. Build details are in
`docs/IMPLEMENTATION_PLAN.md`; current state and next steps are in `docs/SESSION_HANDOFF.md`.

## 1. What Taviron is for

One authoritative record per job, carried through every stage:

> customer request → quote or approved pricing → order → dispatch → delivery ticket → billing readiness →
> invoice preparation → payroll readiness

Employees should never re-enter the same job in another module. Every stage reads the record the previous stage created.

## 2. Workflow status, verified 2026-10-11

| Stage | Status | Notes |
| --- | --- | --- |
| Customers, materials, price lists | Working | Customer-specific rates with effective dates. |
| Quote → order | Working | Accepted quote becomes one order with the accepted terms and prices. Repeats return the same order. |
| Direct orders | Working | Lines may be material, hauling, service, surcharge, discount or other. |
| Order → dispatch | Working (N14 closed a gap) | Confirmed orders without a date wait in "Needs scheduling" (Dispatch and Command Center). They used to be invisible. |
| Dispatch → driver → ticket | Working | Eligibility rules are enforced; drivers submit tickets with photos; office enters paper tickets. Duplicates are prevented and corrections are revisions. |
| Ticket → billing readiness | Working | Derived from loads, tickets, review and acknowledged differences. |
| Invoice preparation | Draft only (N14) | Computed from accepted tickets × approved order prices. Not stored, not issued. |
| Handoff to accounting | Working (CSV) | Batches with audit and safe reversal. The CSV is not a QuickBooks import format. |
| Invoice issue, payment | Not in Taviron | Happens in the accounting system; not tracked. |
| Payroll readiness | Inputs only | `verified_delivery_inputs` (accepted tickets per driver and truck). No earnings: pay rules unknown. |
| Reports | Measured basics (N14) | Verified delivered value, rework, billing turnaround, truck utilization and downtime. No profitability (no cost data). |

**States kept separate:**
- Order: confirmed → scheduled → dispatched / in progress → completed. On hold and canceled sit outside this sequence.
- Load assignment: assigned or not.
- Ticket: submitted → needs review → accepted, voided or superseded.
- Billing: readiness → handed off.
- Invoice: drafted (computed), then issued and paid outside Taviron.

## 3. Decisions

**Confirmed (in code and in force):**
- Multi-tenant, with each company's numbering, pricing, permissions and settings its own. No company's habits become defaults.
- Recommendations never act on their own. Dispatch changes, ticket acceptance, billing handoffs and invoices need an authorized person.
- Estimates stay separate from actuals. Missing data is never shown as "no problems".
- The platform-owner role is separate from company roles and is granted only by an operator.
- The public website stays behind the early-access gate unless `PUBLIC_SITE=on`.

**Proposed, not confirmed:**
- Pricing: from $499 per month per company. Founding offer for the first 10 companies: 20% off ($399.20), onboarding fee waived in beta, billing from go-live. All subject to a written agreement.
- QuickBooks Online as the first accounting target, to be verified with a test company first.
- Privacy and Terms are drafts awaiting legal review.

## 4. Open business questions (need answers from the business)

1. **Driver pay:** formulas per load, ton or hour; minimums, special rates, pay periods, approval chain, export format.
2. **Order types:**
   - Customer pickup at the yard (no delivery).
   - Hauling-only jobs with customer or third-party material: who owns the material, and what goes on the ticket.
   - Whether stone and sand sales need their own order type.
   - Today an order's lines express material and hauling charges, but there is no "fulfillment type" or "material source" field. N14 does not invent one.
3. **Invoicing:**
   - Which lines without their own tickets (e.g. hauling per ton) should bill at delivered vs ordered quantity.
   - Invoice numbering.
   - Whether Taviron or the accounting system issues invoices.
4. **Cost data for profitability:** fuel, wages, maintenance, material purchase cost, equipment ownership.
5. **Escalation rules for urgent orders** beyond a single time limit.
6. **Maintenance policy:** which defects block dispatch, and who returns equipment to service.

## 5. Direction (ordered by dependency)

1. **Staging verified end to end:**
   - Migrations pushed (N13 and N14).
   - Platform role granted.
   - Phone sign-in confirmed.
   - Auth email set up.
2. **First real team-led onboarding**, with parallel running.
3. **Order types**, once the business confirms pickup, hauling-only and material-source rules.
4. **Invoice workflow.** Approval and issue states, and numbering, once it is decided whether Taviron issues invoices.
5. **Payroll readiness → earnings → approval → export**, once pay rules are written.
6. **Maintenance and defects**, feeding dispatch eligibility and the Command Center.
7. **Profitability**, once cost data exists. Separate measured figures from estimates, and account for volume and seasonality.

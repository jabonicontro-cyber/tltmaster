# B42 Order-to-Cash Control Center — readiness map (2026-10-13)

Preparation only. **B42 is queued and not started**; nothing here changes the product. Written from the repository
(file paths below were checked), so the first step of B42 ("repository audit first") starts from facts.

## 1. What exists today

| Stage | Built | Where |
| --- | --- | --- |
| Order | Status machine (draft → confirmed → scheduled → dispatched → in progress → partially completed / completed; on hold and canceled need a reason), append-only status events, price protection for quote-linked orders | `supabase/migrations/20261010000600_orders.sql`, `20261012000100_order_management.sql` (`set_order_status`, `effective_prices`); `src/lib/orders/status.ts`, `history.ts`, `progress.ts` |
| Fulfillment | `order_fulfillment` view: fulfilled yes/no and the first gap (no loads, tickets pending, quantity short, …) | `20261027000100_smart_dispatch_workflow_branding.sql` |
| Loads | `order_loads` + `dispatch_assignments`; load status is only planned / canceled; "done" is derived from an accepted ticket | `20261014000100_dispatch_assignments.sql` |
| Delivery tickets | submitted → needs review → accepted / voided; corrections create a revision and supersede the old one; append-only events; scans | `20261015000100_delivery_tickets.sql`, `20261022000100_ticket_processing.sql`; `src/lib/tickets/rules.ts` |
| Billing readiness | Derived views per load, line and order; exceptions (quantity, units, missing tickets, zero rate, PO missing); readiness precedence handed off › missing documentation › needs review › blocked › in progress › ready; **full-order rule** (a partly delivered order is never ready); exact quantity match, no tolerance | `20261016000100_billing_readiness.sql` (redefined in `20261027000100…`); `src/lib/billing/rules.ts`; `src/server/data/billing.ts` |
| Office decisions | Acknowledged exceptions (append-only, fingerprinted), handoff batches `B-YYYY-NNNN` with a frozen snapshot, one active handoff per order, revert once with a reason, export count, "changed since handoff" flag | `billing_reviews`, `billing_handoffs`, `billing_handoff_orders`; `hand_off_orders`, `revert_billing_handoff`, `record_billing_export` |
| Invoice draft | Computed preview only (delivered / ordered / fixed / percentage basis, tax via the quote calculator) — never stored, numbered, approved, issued or exported | `src/lib/billing/invoice-draft.ts` |
| Reporting | Verified delivered value, billing turnaround | `20261026000100_operations_report.sql`, `/reports` |
| Tests | `tests/db/billing.test.ts` (readiness, reconciliation, acknowledgments, handoff, concurrency, isolation, rule parity), order/ticket DB tests; `tests/e2e/billing.spec.ts`; unit `invoice-draft`, `billing-rules` | |
| Demo data | Presenter seed: a delivered-and-verified order ready for billing, tickets waiting for review (one flagged), Net 30 customers, one PO-required customer; Prairie Lantern: Net 30, PO required on every third customer. **No handoff batches or acknowledgments are seeded.** | `src/server/demo/seed.ts`, `prairie-lantern*.ts` |

## 2. Not built (each needs an owner decision or approval before code)

- Stored invoices: numbering, approval, issuance, delivery to the customer (§9 Q10; CLAUDE.md: no real invoices
  without explicit authorization).
- Accounts receivable, payments, receipts, reconciliation, disputes, collections, credit limits — no tables or code
  (`customers.payment_terms` is free text).
- Accounting export/integration: the handoff CSV (`tlt-billing-handoff-v1`) is not a QuickBooks import; Desktop vs
  Online undecided (IMPLEMENTATION_PLAN §5 notes).
- Customer portal, contracts beyond price lists, a versioned company policy engine, task/SLA infrastructure, billing
  alert types, scheduled jobs beyond the Communications cleanup.
- Load-level delivery events (arrived / started / delivered) — completion is inferred from tickets.

## 3. Decisions B42 depends on (already listed in master plan §9)

Q9 billing quantity when tickets are missing or partial · Q10 invoice numbering, issuance, partial billing, export ·
Q13 recurring billing date · Q15 legal, tax and payment-processor terms · Q19 definition of "fully delivered" ·
QuickBooks edition (§7) · whether Taviron issues invoices at all.

## 4. Safe preparatory work (no schema, no financial workflow, no external communication)

1. **Seed billing history in demos** — a handed-off batch and an acknowledged exception through the existing
   functions, added to `src/server/demo/samples.ts` so Refresh delivers it. Makes the existing billing screens show
   every state today; B42 would reuse it.
2. **One read-only "order lifecycle" summary** built from what exists (order status, fulfillment gap, billing
   readiness, handoff) — the backbone of B42's lifecycle panel — as a pure function with unit tests.
3. **State-dimension glossary**: map each B42 dimension to today's source (or "not built") in this file, kept
   current.

Items 1–2 are product changes and wait until B42 (or a separate request) is explicitly started.

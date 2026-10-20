# Reference numbers

Human-readable references for orders, quotes, delivery tickets, billing hand-off batches, customers and maintenance
work orders. Migration `20261120001300_reference_numbers.sql` (rollback in `supabase/rollbacks/`, not destructive).
Status: **implemented and locally tested; not applied to any hosted database** (runbook §14 Phase B).

## 1. What existed (audit 2026-10-20)

| Record | Column | Generator | Old default format | Uniqueness |
| --- | --- | --- | --- | --- |
| Order | `orders.order_number` | `private.next_document_number(company, 'order')` | `O-2026-0001` | per company |
| Quote | `quotes.quote_number` | same, `'quote'` | `Q-2026-0001` | per company |
| Delivery ticket | `delivery_tickets.ticket_number` (+ `revision`) | same, `'ticket'` (driver and office) | `T-2026-00001` | per company + revision |
| Billing hand-off batch | `billing_handoffs.batch_number` | same, `'billing'` | `B-2026-0001` | per company |
| Customer | `customers.customer_number` | insert trigger, `'customer'` | `C-00001` | per company |
| Work order (truck/trailer) | `work_orders.number` | same, `'work_order'` | `WO-2026-0001` | per company |

- Already central and server-side: one locked row per company and record type (`SELECT … FOR UPDATE`) serializes
  concurrent requests; the number is part of the creating transaction, so a failed request gives it back.
- Retries: order and quote creation, ticket submission, billing hand-off and work orders already use submission or
  request keys, so a double click returns the same record and number.
- Configurable already: Settings → Numbering (prefix, year, width, next number; `settings.manage`; audited).
- **Invoices:** there is no issued-invoice record. Invoice drafts are previews (nothing is issued or exported), so no
  invoice number has ever been issued and none is defined here. When issuing is built, it gets its own sequence; issued
  numbers must then never change. Payment provider references stay separate (no payment integration exists).
- Loads are numbered within their order (`order_loads.load_number` 1, 2, …), shown as "ORD-1042 · load 2".

## 2. What changed

- **Standard for new records:** `ORD-1001`, `QTE-1001`, `TKT-1001`, `BIL-1001`, `CUS-1001`, `MWO-1001`: prefix,
  hyphen, four digits starting at 1001 (no leading zeros until 10,000, then five digits), no year. Customers and drivers
  were proposed as optional; customers already had numbers, so they follow the standard. Drivers keep their employee
  number (no new driver reference was needed). Work orders use `MWO` (maintenance work order) so they cannot be confused
  with orders.
- Applied to every company whose numbering was still on the old platform default, and to every new company (a trigger
  on `document_sequences`). A company that had customized its numbering keeps it exactly.
- **Nothing is renumbered.** Existing records keep `O-2026-0001` etc.; old links, PDFs, emails and exports still
  resolve. Old and new prefixes cannot collide.
- **Never reissued:** the generator skips any reference already used by the company for that record type (for example
  after an administrator changes the format back), and the next number can no longer be lowered in Settings (only
  allocation itself, including a yearly restart for year-based formats, moves it).
- **Search:** each table has a stored, indexed search key (upper case, letters and digits only). Global search and
  the Orders, Quotes, Delivery Tickets, Customers and Work Orders lists match `ORD-1042`, `ord1042`, `ORD 1042`,
  `o-2026-0001` and `O20260001` alike. Searches run with the person's own session, so row-level security still limits
  them to their company and dispatch bases. A reference is an identifier, never an authorization.
- Global search now also covers work orders (`maintenance.view`).
- Record headers (order, quote, ticket, work order) have a **copy reference** button.

## 3. Where references appear

Unchanged code paths show whatever reference a record has, so new records show the new format everywhere the old one
appeared: lists and detail headers, dispatch board and load cards (`ORD-… · load n`), driver My Day and ticket
screens, Command Center items, the customer portal (orders and quotes), quote PDFs (`QTE-1001-v1.pdf`), billing
hand-off CSV (`billing-handoff-BIL-1001.csv`, order and ticket numbers per row), notifications and audit history.

## 4. Tests

- DB `tests/db/reference-numbers.test.ts` (5): new-company standard and independence; never reissue and no lowering;
  two concurrent connections get different numbers; a rolled-back transaction gives its number back; search keys;
  company isolation and `settings.manage`.
- Existing DB and e2e tests updated from the old formats (orders, quotes, tickets, billing, maintenance, tenancy,
  permissions, driver portal); `tests/db/tenancy.test.ts` reviews the new definer function.
- Unit `tests/unit/global-search.test.ts` (`referenceKey`); e2e `tests/e2e/reference-numbers.spec.ts` (search typed
  without punctuation, legacy numbers, copy button, another company sees nothing).

## 5. Owner step

Apply `20261120001300` with Phase B (runbook §14). From that moment new records use the new format; the first new
number continues from the company's current counter or 1001, whichever is higher.

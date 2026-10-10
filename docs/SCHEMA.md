# Database schema

Migrations: `supabase/migrations/` (apply in filename order). All IDs are UUIDs;
human-readable numbers (`C-00001`, `Q-2026-0001`) come from `document_sequences`.
Timestamps are `timestamptz`; calendar dates (quote date, expiration) are `date`.
Money is integer cents (`bigint`); quantities are `numeric(12,3)`; percentages are
basis points (`525` = 5.25%).

## Companies and access

Every business table below carries `company_id` (see docs/ARCHITECTURE.md →
Companies). Relations between business tables are composite foreign keys
`(company_id, …)`, so a row can only reference rows of its own company.

| Table | Purpose |
| --- | --- |
| `companies` | Tenant: name, unique slug, active. Top Line Trucking is `00000000-0000-4000-8000-000000000001`. |
| `company_memberships` | User ↔ company with `role` (`owner`/`office`/`dispatcher`/`mechanic`/`driver`, null = waiting for a role) and `active`. Unique per (company, user). |
| `profiles` | One row per Supabase Auth user: name, email, `active_company_id` (which company to work in when the user has several memberships). Created by trigger on `auth.users`. No role. |
| `permissions` | Global catalog of permission codes (`quotes.edit`, `pricing.override`, …). |
| `role_permission_defaults` | Global default grants copied to each new company. |
| `role_permissions` | Per company: which role has which permission. Owner always has all. |
| `company_settings` | One row per company: name/address/contact, timezone, default tax rate, quote validity and follow-up days, default terms, footer. |
| `document_sequences` | Per company: prefix, year handling, padding and next value for customer, quote, order and ticket numbers. |
| `audit_events` | Append-only log per company: who, when, action, entity, summary, JSON details of changed fields. |

## Customers

| Table | Purpose |
| --- | --- |
| `customers` | Number, name, type (commercial/residential), main email/phone, billing address, PO requirement + instructions, payment terms (informational), optional `price_list_id`, tax-exempt flag, notes, `active`, `is_sample`. |
| `customer_contacts` | People at the customer; at most one active primary contact; billing flag. |
| `customer_sites` | Delivery / job-site addresses with directions; latitude/longitude reserved for routing. |

## Catalog and pricing

| Table | Purpose |
| --- | --- |
| `units_of_measure` | Per company (key `(company_id, code)`): `ton`, `load`, `cu_yd`, `hour`, `mile`, `day`, `each` (+ your own). |
| `materials` | Name, optional code, default unit, taxable default. |
| `charge_items` | Non-material charges: hauling, service, surcharge, discount, other; per unit or % of subtotal. |
| `price_lists` | `Standard rates` (exactly one per company) plus customer-specific or shared lists. |
| `price_list_entries` | Rate (cents per unit) or percentage for a material/charge, with `effective_from`/`effective_to` for history. |

Price resolution for a quote line (`private.resolve_price`, `public.effective_prices`):
the customer's price list entry effective on the quote date → the standard
list entry → no configured price (rate entered manually).

## Quotes

| Table | Purpose |
| --- | --- |
| `quotes` | Header: number, customer, status (`draft`, `sent`, `accepted`, `declined`, `expired`, `canceled`), current revision, accepted revision, sent/accepted/closed times. |
| `quote_versions` | One row per revision: contact, job site, dates, project, PO, instructions, terms, internal notes, tax rate, computed totals, `locked_at` (issued), `sent_at`, and `bill_to_snapshot` / `company_snapshot` captured when issued. |
| `quote_lines` | Per revision: kind, calculation method, material/charge reference, description, unit + label, quantity, rate or percent, the configured rate at the time, price source (`customer`/`standard`/`manual`/`override`), taxable, amount. |
| `quote_status_events` | Append-only status history with notes. |
| `email_deliveries` | Every delivery attempt: channel (email/manual), status (`sent`/`failed`/`preview`/`test_sent`), recipients, subject, body, provider message id, error, linked document. Append-only. |
| `documents` | Generated PDFs that were sent: filename, SHA-256, size. Append-only. |
| `quote_list` (view) | Quote + customer + current revision for lists (security-invoker, so RLS applies). |

### Quote functions (all `SECURITY DEFINER`, permission-checked)

| Function | Does |
| --- | --- |
| `save_quote_draft(payload)` | Create quote (allocates number) or update the current draft revision; validates; resolves prices; enforces `pricing.override`; replaces lines; computes totals; optimistic concurrency via `edit_seq`. |
| `issue_quote_version(quote, edit_seq)` | Locks the current revision and captures snapshots (before emailing). |
| `record_quote_delivery(...)` | Records an email attempt; on success marks the quote Sent; on failure/test releases the lock. |
| `mark_quote_sent(quote, edit_seq, note)` | Issue + record a manual delivery in one transaction. |
| `revise_quote(quote, reason)` | New draft revision copied from the issued one. |
| `set_quote_status(quote, status, note)` | Accepted/declined/expired/canceled with transition rules. |
| `remove_sample_data()` | Owner-only cleanup of fictional records (including orders created from sample quotes). |

### Totals

```
per-unit line   amount = round(quantity × rate)                       (cents, half away from zero)
percent line    amount = round(base × percent / 100)                  base = Σ per-unit, non-discount lines
discount line   amount is negative
subtotal        = Σ non-discount lines
discounts       = −Σ discount lines
taxable         = max(0, Σ lines marked taxable)
tax             = round(taxable × tax rate)
total           = subtotal − discounts + tax
```

## Orders

| Table | Purpose |
| --- | --- |
| `orders` | Order number (`O-2026-0001`), customer, status (`draft`, `confirmed`, `scheduled`, `dispatched`, `in_progress`, `partially_completed`, `completed`, `on_hold`, `canceled`), **`source_quote_id` (unique) + `source_quote_version_id`** — the permanent link to the quote and the exact revision accepted — and copies of that revision's bill-to snapshot, contact, job site, project, PO, instructions, terms, internal notes, tax rate and totals. |
| `order_lines` | Copies of the accepted revision's lines with their pricing snapshots (rate, configured rate at the time, price source incl. overrides, discounts), plus `source_quote_line_id`. |
| `order_status_events` | Append-only order status history. |
| `order_list` (view) | Order + customer + source quote number for lists (security-invoker). |

`convert_quote_to_order(quote_id)` (`SECURITY DEFINER`, requires `orders.edit`):
locks the quote row, returns the existing order (`created: false`) if the quote
was already converted, otherwise requires status `accepted` and an issued
accepted revision, allocates an order number, copies header and lines, sets the
order to **Confirmed**, and writes order history and audit events on both the
order and the quote. The unique `source_quote_id` is the final guard against
duplicates. Once converted, the quote's status can no longer change
(`quotes_guard_converted` trigger). Clients have read-only access to order
tables, so prices on an order cannot be changed around the owner-only override
rules. Orders created from sample quotes are removed with the sample data.

## Planned tables (later phases)

Order scheduling (delivery dates, loads), trucks, drivers, dispatch assignments, route plans and
stops, delivery tickets and ticket lines, planning runs, integration records
(QuickBooks IDs, sync status, errors).

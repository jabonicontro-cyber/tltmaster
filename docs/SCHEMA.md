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

### Early access and onboarding (private schema, not reachable through the API)

| Table | Purpose |
| --- | --- |
| `private.early_access_codes` | Operator-issued codes: `code_hash` (SHA-256 of the normalized code, unique — the code is never stored), `label`, `max_uses` (1–1000), `expires_at`, `revoked_at`, `revoke_reason`. |
| `private.early_access_redemptions` | One use of a code: `code_id`, `user_id`, `company_name`, `request_key` (unique; makes retries idempotent), `status` (`reserved` → `completed`), `company_id`. At most one pending reservation per account. |
| `private.access_attempts` | Failed and successful code attempts by scope (`ip`, `email`, `user`) and keyed hash, for rate limiting (failures in the last 15 minutes). |

Functions: `early_access_check`, `early_access_reserve`, `early_access_request`,
`early_access_create_code`, `early_access_list_codes`, `early_access_revoke_code`
(service role only); `my_onboarding`, `complete_company_onboarding`,
`create_company_with_access_code`, `my_companies`, `switch_company`,
`add_existing_member` (signed-in users, checked inside). `add_company_member` and
`set_user_access` let only owners grant or remove the Owner role. Migration
`20261020000100_company_onboarding.sql`.

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
| `orders` | Order number (`O-2026-0001`), customer, status (`draft`, `confirmed`, `scheduled`, `dispatched`, `in_progress`, `partially_completed`, `completed`, `on_hold`, `canceled`) and `status_note` (last reason), **`source_quote_id` (unique) + `source_quote_version_id`** — the permanent link to the quote and the exact revision accepted, null for direct orders — bill-to snapshot, contact (`contact_id` + copied name/email/phone), job site, project, PO, instructions, terms, internal notes, tax rate and totals. Scheduling: `order_date`, `requested_date`, `scheduled_start` / `scheduled_end` (date range), `window_start` / `window_end` (daily time window), `scheduling_notes`. `edit_seq` (optimistic concurrency), `confirmed_at`, `completed_at`, `canceled_at`, `updated_by`. |
| `order_lines` | Line items with pricing snapshots (rate, configured rate at the time, price source incl. overrides, discounts). Quote-linked orders: copies of the accepted revision's lines plus `source_quote_line_id`. |
| `order_status_events` | Append-only order status history (from, to, note, who, when). |
| `order_list` (view) | Order + customer + source quote number + scheduling fields + material summary for lists (security-invoker). |

### Order rules

- **Pricing protection** (triggers `orders_guard_pricing`, `order_lines_guard`, which
  also bind the database owner): lines, totals, tax rate, terms and customer can
  change only while the order is a **direct order in Draft**. Order number and
  source quote never change. Lines are otherwise written only by the quote
  conversion (`tlt.order_conversion` transaction flag) or removed by the owner-only
  sample purge.
- **Status transitions**: `private.order_transition_allowed` (table in
  docs/IMPLEMENTATION_PLAN.md §5a, mirrored by `src/lib/orders/status.ts`).
  Confirming a draft and canceling need `orders.edit`; every other move needs
  `orders.schedule`. Scheduled / dispatched / in progress need a scheduled date;
  on hold and canceled need a reason; confirming needs a line. Completed and
  canceled are final: no further status, detail or schedule changes.
- **Checks**: scheduled end ≥ start (no end without a start); time window both or
  neither, end after start; requested and scheduled dates not before the order date.

### Order functions (all `SECURITY DEFINER`, company- and permission-checked)

| Function | Permission | Does |
| --- | --- | --- |
| `save_order_draft(payload)` | `orders.edit` | Create a direct order (allocates number, status Draft) or update its draft: customer, contact, site, dates, terms, tax, lines priced like quotes on the order date; `pricing.override` for overrides and discounts; `edit_seq` conflict check. |
| `update_order_details(order, edit_seq, payload)` | `orders.edit` | Contact, job site, project, PO, instructions, internal notes, requested date of any open order. Never prices. Audits a field diff. |
| `update_order_schedule(order, edit_seq, payload)` | `orders.schedule` | Scheduled date range, time window, scheduling notes. Audits a field diff. |
| `set_order_status(order, status, note, edit_seq)` | per transition | Applies the transition rules, sets timestamps, writes a status event and an audit entry. |
| `convert_quote_to_order(quote)` | `orders.edit` | See below. |

Audit entries of orders (`entity_type = 'order'`) are readable by everyone with
`orders.view` in the company (policy `audit_read_orders`); the rest of the audit
log needs `audit.view`.

`convert_quote_to_order(quote_id)` (`SECURITY DEFINER`, requires `orders.edit`):
locks the quote row, returns the existing order (`created: false`) if the quote
was already converted, otherwise requires status `accepted` and an issued
accepted revision, allocates an order number, copies header and lines, sets the
order to **Confirmed** (recording the order date, contact and confirmation time), and writes order history and audit events on both the
order and the quote. The unique `source_quote_id` is the final guard against
duplicates. Once converted, the quote's status can no longer change
(`quotes_guard_converted` trigger). Clients have read-only access to order
tables, and the pricing triggers above keep the accepted prices, so prices on an
order cannot be changed around the owner-only override rules. Orders created from
sample quotes, and direct orders of sample customers, are removed with the sample data.

## Fleet

| Table | Purpose |
| --- | --- |
| `trucks` | Unit number (unique per company, case-insensitive), `truck_type`, make, model, year, VIN, plate. `weight_capacity` + `weight_unit` (`ton` / `lb`) and `volume_capacity` + `volume_unit` (`cu_yd`), each pair both-or-neither, `NULL` = unknown; `capacity_source`, `capacity_verified_at/by`. `active`; `service_status` (`in_service` / `out_of_service`) with `out_of_service_reason` (required when out), `out_of_service_since`, `expected_return_date`. |
| `trailers` | Same as trucks with `trailer_type`, `compatible_truck_types truck_type[]` (empty = not recorded), `compatibility_notes`, `default_truck_id` (same company). Own service status. |
| `equipment_status_events` | Append-only service-status history (truck or trailer, from, to, reason, expected return, who, when). |
| `drivers` | Optional `user_id` → `company_memberships (company_id, user_id)` (one driver per account), or a `name`; employee number (unique per company), phone, hire date, active, notes. |
| `driver_qualifications` | `kind` (`cdl`, `medical_card`, `hazmat`, `twic`, `other`), `cdl_class` (required for CDLs), endorsements, description (required for other), issuing state, issued / expires (`NULL` = unknown), `verified_at/by`, notes. No license numbers. |
| `driver_list` (view) | Drivers with a display name (the linked account's name, else the stored name) and the account's active flag and role (security-invoker; names via `private.member_summary`, limited to the caller's company). |

### Fleet rules

- **Writes**: tables are written directly under RLS (`fleet.edit`), but the service
  columns have no client grants: `set_equipment_service_status(kind, id, status,
  reason, expected_return)` (`fleet.service`) changes them and writes the history.
  Trucks, trailers and drivers are never deleted (deactivate); qualifications may
  be deleted (audited).
- **Verification**: clients send any non-null `*_verified_at` to mean "verified";
  the trigger `private.stamp_fleet_row` records the time and the user, keeps the
  original stamp when the values are unchanged, and the app clears the flag when
  values are edited.
- **Eligibility**: `check_assignment_eligibility(truck, trailer, driver, on)`
  (`fleet.view`) returns `{eligible, blockers[], warnings[]}` — rules in
  docs/IMPLEMENTATION_PLAN.md §5b; helpers `private.qualification_check`,
  `private.cdl_class_rank`.
- **History**: audit triggers on every fleet table; fleet audit entries are
  readable with `fleet.view` (policy `audit_read_fleet`).

## Dispatch

| Table | Purpose |
| --- | --- |
| `order_loads` | Planned trips of an order: `load_number` (per order), `load_date`, `start_time`, `end_time` (local business time) and the derived `starts_at` / `ends_at` (timestamptz in the company's timezone), optional `planned_quantity` + `unit_code` (company units, both or neither), notes, `status` (`planned` / `canceled`, with reason). Must fall within the order's scheduled dates; the order must be Scheduled, Dispatched, In progress or Partially completed. |
| `dispatch_assignments` | Truck, optional trailer and driver for a load, with the load's interval copied in; `status` (`active` / `canceled` with reason), note, accepted eligibility `warnings`, `replaces_assignment_id`. One active assignment per load. Immutable except cancellation; never deleted. |

### Dispatch rules

- **No double-booking**: `EXCLUDE USING gist` on `(truck_id | trailer_id | driver_id, tstzrange(starts_at, ends_at, '[)'))` for active rows — half-open intervals, so back-to-back loads are allowed; holds under concurrent requests.
- **Eligibility**: `assign_load` applies the fleet rules (`private.assignment_eligibility`) on the load date, plus "a tractor needs a trailer"; blockers refuse, warnings are stored.
- **Functions** (`dispatch.edit`): `save_order_load(payload)`, `cancel_order_load(load, reason)`, `assign_load(load, truck, trailer, driver, note, replace_assignment_id)`, `cancel_assignment(assignment, reason)`. Changing an assigned load's time re-checks eligibility and conflicts.
- **Order changes**: canceling an order, putting it on hold or moving it back to Confirmed cancels its active assignments that have not ended (trigger `orders_release_assignments`); canceling also cancels its planned loads.
- **Reading**: `dispatch.view` or `orders.view`; no client writes.

## Delivery tickets

| Table | Purpose |
| --- | --- |
| `delivery_tickets` | One row per **revision**. `ticket_number` (per-company `ticket` sequence, e.g. `T-2026-00001`) stays the same across revisions; `revision`, `supersedes_id`. `status` (`submitted`, `needs_review`, `accepted`, `voided`, `superseded`). References (same company): order, load, the assignment active at submission, order line (and its material), truck, trailer, driver, unit. Actual `delivered_at`, `quantity numeric(12,3)` + `unit_code` (explicit, never defaulted or converted), `external_reference` (paper/scale ticket number), notes, `review_reasons[]`, `snapshot` (order/load numbers, customer, line description and unit, truck/trailer unit numbers, driver name, planned quantity), `correction_reason`, review and void metadata, `submission_key` (idempotency). |
| `delivery_ticket_events` | Append-only history per ticket number: submitted, flagged, accepted, voided, corrected (with field changes). |

### Ticket rules

- **Writes** only through `submit_delivery_ticket(payload)` (`tickets.edit`),
  `correct_delivery_ticket(ticket, payload, reason)` (`tickets.edit`; an accepted
  ticket needs `tickets.review`) and `review_delivery_ticket(ticket, accept | flag
  | void, note)` (`tickets.review`; flag and void need a reason). Reading:
  `tickets.view` or `orders.view`.
- **Validation** (`private.prepare_ticket`): planned load with an active
  assignment; order Scheduled / Dispatched / In progress / Partially completed /
  Completed; per-unit order line of that order; quantity > 0 with ≤ 3 decimals,
  whole numbers for `load` and `each`; delivery time not in the future and not
  over a year ago; truck / trailer / driver of the company.
- **Review flags** (status `needs_review`): unit differs from the order line,
  delivered on another day than planned, equipment differs from the assignment,
  no external reference, another ticket on the load, reused external reference.
- **Immutability**: revisions never change except status and review/void
  fields along allowed paths (`guard_delivery_ticket`); never deleted (except
  with their sample order). A load with live tickets cannot be canceled
  (`order_loads_guard_tickets`), nor can its order.
- One current revision per number (partial unique index); repeated submissions
  return the same ticket (unique `submission_key`).

## Billing readiness

Readiness is **derived**, not stored: four `security_invoker` views compute it
from the records on every read (the caller's RLS applies).

| View | One row per | Gives |
| --- | --- | --- |
| `billing_load_status` | planned load of an order that is Scheduled / Dispatched / In progress / Partially completed / Completed | `is_due` (planned end passed, or order Completed), live / accepted / pending ticket counts, `delivered_quantity` (live tickets in the load's planned unit), `other_unit_count`, voided ticket numbers, `documentation_state` (`missing`, `not_due`, `needs_review`, `documented`), `quantity_check` (`no_tickets`, `not_planned`, `units_differ`, `match`, `over`, `under`) and `quantity_difference`. Canceled loads are not listed. |
| `billing_line_status` | per-unit, non-discount order line of such an order | Ordered vs delivered (live tickets for the line in the line's unit); `quantity_check` evaluated once the order is Completed (`in_progress` before); `pricing_check` (`ok`, `zero_rate`). Prices are shown, never recalculated. |
| `billing_exceptions` | exception | `load_quantity`, `load_units_differ`, `line_quantity`, `line_units_differ`, `line_no_tickets`, `line_zero_rate`, `po_missing` (customer requires a PO, order has none), with expected / actual quantity, unit and difference, and a `key` holding the compared values. |
| `billing_order_status` | order in scope | Counts, service dates (first/last load, else scheduled dates), `exceptions_fingerprint` (md5 of the exception keys), `documents_fingerprint` (md5 of current ticket ids and statuses), the current acknowledgment, the active handoff, `changed_since_handoff`, and `readiness`. |

**Readiness precedence** (first that applies): `handed_off` › `missing_documentation`
(a due load without a live ticket, or a Completed order with no ticket) ›
`needs_review` (a live ticket not accepted) › `blocked` (exceptions without a
current acknowledgment) › `in_progress` (order not Completed) › `ready`.

| Table | Purpose |
| --- | --- |
| `billing_reviews` | Append-only office acknowledgment of an order's exceptions: `fingerprint`, the exceptions as reviewed (JSON), required `reason`, who and when. Counts only while the order's current fingerprint matches. |
| `billing_handoffs` | Batch: `batch_number` (per-company `billing` sequence, `B-2026-0001`), reference, notes, `submission_key` (idempotency), who and when, `export_count` / `last_exported_at/by` (file downloads). |
| `billing_handoff_orders` | Order in a batch with the `documents_fingerprint` and a frozen `snapshot` (order header and totals, all lines with accepted prices, accepted tickets). `reverted_at/by` + `revert_reason` when undone. Partial unique index: one active handoff per order. |

### Billing functions (all `SECURITY DEFINER`, company- and permission-checked)

| Function | Permission | Does |
| --- | --- | --- |
| `acknowledge_billing_exceptions(order, fingerprint, reason)` | `billing.manage` | Records the acknowledgment if the fingerprint still matches (else `PT409`); reason required; audited on the order. |
| `hand_off_orders(order_ids, reference, notes, submission_key)` | `billing.manage` | Locks the orders, their loads and tickets; refuses orders already handed off (`PT409`) or not `ready`; allocates the batch number; stores snapshots; audits each order. Repeating the key returns the same batch. |
| `revert_billing_handoff(handoff_order, reason)` | `billing.manage` | Undoes one order's handoff once, with a reason; audited. |
| `record_billing_export(handoff)` | `billing.view` | Counts and logs a download of the batch file. |

Guards: batch rows change only by counting downloads; handoff rows only by being
undone once; acknowledgments are append-only; deletes only with a sample order.
Reading: `billing.view` (owner, office). Clients have no write grants.

**Handoff file** (`/billing/batches/[id]/csv`, format `tlt-billing-handoff-v1`):
one row per order line from the frozen snapshot — batch number and reference,
order number and id, customer number and name, PO, project, service dates, line
number and id, description, unit, ordered quantity, accepted delivered quantity
(blank when none), unit rate, percent, line amount, taxable, price source, order
subtotal / discounts / tax / total, ticket numbers and paper ticket numbers.
Undone orders are left out. It is **not** a QuickBooks import format.

## Command center

Exceptions are **derived on every read** by `private.operational_exceptions(company)`
(SECURITY DEFINER, not callable by app users) from loads, assignments, tickets,
the billing views and equipment status. One row per underlying issue, keyed
`kind:entity`: `missing_ticket:<load>`, `unassigned_load:<load>`,
`ticket_review:<ticket number>`, `billing_blocked:<order>`,
`equipment_out_of_service:<truck|trailer>:<id>`, `assignment_problem:<assignment>`.
Each row has `priority` (1 urgent, 2 high, 3 normal), `since` (null when not
reliably known), the affected order / load / ticket / equipment / assignment,
`reasons` (codes) and `details`. Rules and deduplication: docs/IMPLEMENTATION_PLAN.md §5f.

| Function | Permission | Does |
| --- | --- | --- |
| `command_center_summary()` | any of dispatch / tickets / billing / fleet view | Counts per kind and overview figures; a figure the caller may not see is `null`. |
| `command_center_exceptions(kind, mine, limit, offset)` | same | Visible exceptions, priority then oldest first, with the current assignee; `limit` clamped to 1–100; returns `total`. |
| `exception_assignee_options()` | `exceptions.assign` | Active members (name, role) and the kinds their role can resolve. |
| `assign_exception(key, user, note)` | `exceptions.assign` | Only for an exception that is open and visible to the caller, only to an active member whose role holds the resolving permission (`tickets.edit`, `dispatch.edit`, `tickets.review`, `billing.manage`, `fleet.service`); ends the previous assignee; audited. |
| `unassign_exception(key)` | `exceptions.assign` | Ends the current assignment; audited. |

Visibility per kind: missing tickets — `tickets.view` or `billing.view`; loads
without a truck and assignment problems — `dispatch.view`; tickets to review —
`tickets.view`; billing blocks — `billing.view`; equipment — `fleet.view`.

| Table | Purpose |
| --- | --- |
| `exception_assignments` | Who was asked to handle an exception: key, kind, `assigned_to` (same-company member; removed with the member), note, who/when; `ended_at/by` + `end_reason` (`reassigned`, `unassigned`). One current row per key. Not a status: the exception stays until its record changes. Readable by `exceptions.assign` holders and by the assignee. |

Order history entries whose action starts with `billing.` are readable only with
`billing.view` (policy `audit_read_orders`).

## Driver portal and field reports

A portal user is the active member of the current company whose account is
linked to an **active** driver record (`drivers.user_id`, same-company FK, one
driver per account). Drivers have no table access; they use these functions
(all SECURITY DEFINER, `driver.portal`), which resolve the driver from the
session and accept only the driver's own active assignments:

| Function | Does |
| --- | --- |
| `driver_portal_home()` | Own assignments (two days back without a ticket, today, tomorrow) with driver-safe order, site, load, truck/trailer and ticket fields — no prices, totals, internal or scheduling notes; own recent tickets and reports; own qualification dates. |
| `driver_assignment_form(assignment)` | One own assignment plus the order's per-unit lines (description, unit) and the company's units. |
| `driver_submit_ticket(payload)` | Through `private.create_ticket` (the same path as `submit_delivery_ticket`): own active assignment, load dated today or earlier, driver/truck/trailer from the assignment, required submission key (retry → same ticket; another user's key → refused). |
| `driver_submit_field_report(payload)` | Report on an own assignment (two days back to tomorrow), idempotent. |

| Table | Purpose |
| --- | --- |
| `field_reports` | `kind` (`delay`, `cannot_complete`, `breakdown`, `equipment_issue`, `inspection_issue`), `status` (`open` → `acknowledged` → `resolved`), driver, assignment, load, order, `equipment` (`truck`/`trailer` for equipment kinds) + ids, description, `snapshot` (order/load numbers, date, customer, units, driver name), `submission_key`, reporter, acknowledge/resolve actor, time and note (resolution note required). Guard: only review fields change, forward only; never deleted (except with a sample order). Read: `field_reports.view`; delay kinds also need `dispatch.view`. |

`review_field_report(report, acknowledge | resolve, note)` (`field_reports.manage`,
same kind rule) records the decision and audits it on the order (delays) or the
truck/trailer (equipment). Reports never change equipment status or
assignments. Open and acknowledged reports appear in the command center as
`delay_report` / `equipment_report`.

## Ticket photos and file storage

Supabase Storage, one **private** bucket `ticket-photos` (`public = false`, 5 MB,
`image/jpeg`, `image/png`, `image/webp`). Object paths are chosen by the database:
`<company_id>/ticket-photos/<attachment_id>.<jpg|png|webp>`.

| Table | Purpose |
| --- | --- |
| `ticket_attachments` | One row per photo: company, `status` (`pending` → `uploaded` → `attached`, or `discarded`), `object_path` (unique; first folder = company), detected `mime_type`, `size_bytes`, `sha256`, `upload_key` (unique per company: retries reuse the row), the driver's `assignment_id` / `load_id` / `order_id`, `ticket_id` + `ticket_number` once attached, uploader and times, discard reason. Guard: forward-only status, identity fields never change, never deleted (except with a sample order). Read (attached rows only): `tickets.view`, same company. |

Storage policies on `storage.objects` (bucket `ticket-photos`): **insert** when
`private.can_upload_ticket_photo(name)` — a `pending` row with exactly that path,
created by the caller, in the caller's company; **select** (read, sign a URL) when
`private.can_read_ticket_photo(name)` — an `attached` row of the caller's company and
`tickets.view`. No update or delete policies (app users can never replace or remove a
photo). Created by `private.setup_ticket_photo_storage()` (idempotent).

| Function | Who | Does |
| --- | --- | --- |
| `driver_begin_ticket_photo(assignment, upload_key, mime, size, sha256)` | driver portal | Own active assignment, load from two days ago to today; JPEG/PNG/WebP, ≤ 5 MB; at most 3 waiting photos per assignment; returns the reserved path. Same key → same row; another user's key → refused. |
| `driver_confirm_ticket_photo(attachment)` | driver portal | The object must exist in `storage.objects` with the declared size and type → `uploaded`; audited on the order. |
| `driver_submit_ticket(payload)` | driver portal | As before, plus `photo_ids` (≤ 3, own, same assignment, `uploaded`) attached in the same transaction; a retry returns the ticket and its photo count. |
| `abandoned_ticket_photos(hours)` / `mark_ticket_photos_discarded(ids)` | service role | Unattached uploads older than `hours` and objects without a record; marking only after the object is gone. Used by `scripts/cleanup-ticket-photos.mjs`. |

Photos belong to the ticket number: kept and shown through corrections (with the
revision they were attached to), voids and supersession. Viewing goes through
`/tickets/photos/[id]`, which checks access with the viewer's token and redirects to a
60-second signed URL.

## Planned tables (later phases)

Maintenance and work orders, drivers, dispatch assignments, route plans and
stops, delivery tickets and ticket lines, planning runs, integration records
(QuickBooks IDs, sync status, errors).

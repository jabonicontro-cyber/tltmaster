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
| `company_settings` | One row per company: name/address/contact, timezone, default tax rate, quote validity and follow-up days, default terms, footer; branding (N15): `brand_logo` (PNG/JPEG/WebP data URL ≤400 000 chars), `brand_color`, `brand_sidebar_color` (hex or empty). |
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

### Coordination (N10)

| Table | Purpose |
| --- | --- |
| `order_urgencies` | An order flagged urgent: reason, optional `needed_by`, `state` (`awaiting_acknowledgement` → `acknowledged` / `evaluating` / `waiting_for_information` / `blocked` / `assigned` → `resolved` or `canceled`), who flagged and who acknowledged. One open flag per order; closed flags are read-only history. Read with `orders.view` or `dispatch.view`. |
| `order_urgency_events` | Append-only history of each flag (flagged, updated, state changed, closed with the order). |
| `user_preferences` | Per user and company: Command Center layout (`order`, `collapsed` section ids). Own rows only. |
| `exception_dismissals` | Per user and company: a non-urgent Command Center item hidden until `hidden_until`. Own rows only; never resolves anything. |

`company_settings.urgent_ack_minutes` (5–1440 or null) sets the escalation time. Functions:
`flag_order_urgent`, `update_order_urgency`, `save_my_preference`, `hide_exception`,
`unhide_exception`. Migration `20261021000100_command_center_coordination.sql`.

### Early-access gate (N12, private schema)

| Table | Purpose |
| --- | --- |
| `private.early_access_codes.purpose` | `company_signup` (N9) or `site_access` (gate); a code never works for the other purpose. |
| `private.site_access_grants` | One per admitted device: code, expiry (≤ code expiry), keyed hash of the address, last seen, revocation. |
| `private.early_access_audit` | Code created / revoked, devices revoked — who (database role) and when. |

Service-role functions: `site_access_redeem`, `site_access_validate`,
`site_access_revoke_grants` (plus `early_access_create_code` with a purpose,
`early_access_list_codes`, `early_access_revoke_code`).

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
| `drivers` | Optional `user_id` → `company_memberships (company_id, user_id)` (one driver per account), or a `name`; employee number (unique per company), phone, hire date, active, notes. `hauler_id` set = a hired-truck driver (another company's, 20261120003700). |
| `employees.driver_id` (People link) | Every driver of the company's own has exactly one People record (`employees`, unique per company and driver; owner decision 2026-11-09, migration `20261120010000`). A one-time backfill created the missing ones, and the triggers `driver_person_insert` / `driver_person_update` on `drivers` (security definer `private.driver_person_insert` / `driver_person_update`, helper `private.driver_person_add`, `search_path = ''`, acting on the driver's own company only) keep it so however a driver is created (Fleet, import, demo seed): a driver with a login joins that login's record when it has no driver, else a new record (name as Fleet shows it, phone, hire date, `operations`, active or inactive from the driver). A Fleet rename follows while the People name still equals the old driver name; deactivating or reactivating a driver without a login sets the record inactive or active (on leave and terminated stay); a new driver record for a login whose record sits on a driver no longer that login's takes the record, and the earlier driver gets its own. Hired-truck drivers get no People record. Rollback (`supabase/rollbacks/20261120010000_driver_people.down.sql`) removes the triggers and functions and keeps the records. Because a People record references its driver (`on delete restrict`), an import revert keeps such drivers deactivated instead of deleting them. |
| `driver_qualifications` | `kind` (`cdl`, `medical_card`, `hazmat`, `twic`, `other`), `cdl_class` (required for CDLs), endorsements, description (required for other), issuing state, issued / expires (`NULL` = unknown), `verified_at/by`, notes. No license numbers. |
| `vehicle_document_rules` | Per company and document kind (registration, insurance, inspection, permit): `block` or `warn` for an expired document; no row = default (insurance and registration block, inspection and permit warn). Read by the company; set only through `set_document_rule` (settings.manage). `vehicle_documents.verified_at/verified_by`: a person confirmed the record (`verify_vehicle_document`, fleet.edit); only a verified expired document on a blocking kind blocks assignment (`assignment_eligibility`, `check_assignment`). |
| `pto_banks` | A company's time-off banks: name, the request categories that draw from it (one active bank per category; several categories = a combined bank), eligible employment types, waiting period in days from the hire date, active. Readable by the company; changed only through `pto_bank_save` (time_off.balances). |
| `pto_policies` | How a bank earns hours per employment type: method (`annual_grant` amount on a month/day; `hours_worked` amount per `per_hours`; `per_pay_period` amount each weekly/biweekly/semimonthly/monthly period from `anchor_date`), optional `max_balance`, plan-year start, `carryover_cap` (null = unlimited; requires `forfeiture_reviewed`), `effective_from`, active (one active per bank and type). |
| `pto_hours_worked` | Append-only eligible hours per employee and ended period (`source` manual or integration), the basis of hours-worked accrual; readable by the employee and time_off.balances. Accruals post into `pto_ledger` with a unique `period_key` so a repeated `pto_run_accruals` adds nothing. |
| `pto_ledger` | Append-only balance history per employee and bank: grant, adjustment (reason required), usage (posted when a request on the bank is approved), usage_reversal (when approved time off is canceled). Balance = sum of hours. Readable by the employee (own) and time_off.balances; written only by functions. `time_off_requests.pto_bank_id` records the bank a request draws from. |
| `driver_list` (view) | Drivers with a display name (the linked account's name, else the stored name; in a demo company the stored name first, so the presenter appears as the persona — migration `20261111000100`) and the account's active flag and role (security-invoker; names via `private.member_summary`, limited to the caller's company). |
| `private.demo_person_name(company, user)` (function) | Demo companies only: the person's employee name, else their driver name; null for real companies. Used first in history lines, field reports, My Day, operational exceptions and assignment labels (migration `20261111000300`; security definer, `search_path = ''`, not executable by API roles). |

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
  `private.cdl_class_rank`. Shop work (owner decision 2026-11-09, migration
  `20261120009800`): an open safety-critical work order (`*_safety_restricted`),
  a work order scheduled for the load date that is not finished
  (`*_shop_scheduled`), and shop work in progress or waiting for parts on any
  date (`*_shop_work_open`) are all blockers for the truck or trailer. The app
  applies the same rule everywhere through `src/lib/fleet/readiness.ts`
  (out of service: not ready today; on a later day ready from the expected
  return date, a planning projection only).
- **History**: audit triggers on every fleet table; fleet audit entries are
  readable with `fleet.view` (policy `audit_read_fleet`).

## Dispatch

| Table | Purpose |
| --- | --- |
| `order_loads` | Planned trips of an order: `load_number` (per order), `load_date`, `start_time`, `end_time` (local business time) and the derived `starts_at` / `ends_at` (timestamptz in the company's timezone), optional `planned_quantity` + `unit_code` (company units, both or neither), notes, `status` (`planned` / `canceled`, with reason). Must fall within the order's scheduled dates; the order must be Scheduled, Dispatched, In progress or Partially completed. |
| `dispatch_assignments` | Truck, optional trailer and driver for a load, with the load's interval copied in; `status` (`active` / `canceled` with reason), note, accepted eligibility `warnings`, `replaces_assignment_id`. One active assignment per load. Immutable except cancellation; never deleted. |
| `dispatch_recommendation_rejections` (N15) | A dispatcher's rejection of one Smart Dispatch truck–driver pair for a load, with an optional reason; `cleared_at`/`cleared_by` when reconsidered. One active row per pair. Written only by `reject_dispatch_recommendation` / `reconsider_dispatch_recommendations` (`dispatch.edit`); read with `dispatch.view`. |

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

### Ticket processing (N11)

- `company_settings.ticket_reference_required` — flag tickets without a paper/scale number
  (default true).
- `begin_ticket_scan(ticket, upload_key, mime, size, sha256)` / `attach_ticket_scan(attachment,
  ticket)` — office scans of paper tickets into `ticket_attachments` (same rules as driver
  photos); history action `photo_added` on `delivery_ticket_events`.
- View `verified_delivery_inputs` — accepted current revisions: ticket, revision,
  `supersedes_id`, order, load (date, times), assignment, order line, material, driver,
  truck, trailer, delivered at, quantity, unit, paper #, verified by/at. Security invoker
  (tickets.view); no money.

## Billing readiness

Readiness is **derived**, not stored: four `security_invoker` views compute it
from the records on every read (the caller's RLS applies).

| View | One row per | Gives |
| --- | --- | --- |
| `billing_load_status` | planned load of an order that is Scheduled / Dispatched / In progress / Partially completed / Completed | `is_due` (planned end passed, or order Completed), live / accepted / pending ticket counts, `delivered_quantity` (live tickets in the load's planned unit), `other_unit_count`, voided ticket numbers, `documentation_state` (`missing`, `not_due`, `needs_review`, `documented`), `quantity_check` (`no_tickets`, `not_planned`, `units_differ`, `match`, `over`, `under`) and `quantity_difference`. Canceled loads are not listed. |
| `billing_line_status` | per-unit, non-discount order line of such an order | Ordered vs delivered (live tickets for the line in the line's unit); `quantity_check` evaluated once the order is Completed (`in_progress` before); `pricing_check` (`ok`, `zero_rate`). Prices are shown, never recalculated. |
| `billing_exceptions` | exception | `load_quantity`, `load_units_differ`, `line_quantity`, `line_units_differ`, `line_no_tickets`, `line_zero_rate`, `po_missing` (customer requires a PO, order has none), with expected / actual quantity, unit and difference, and a `key` holding the compared values. |
| `billing_order_status` | order in scope | Counts, service dates (first/last load, else scheduled dates), `exceptions_fingerprint` (md5 of the exception keys), `documents_fingerprint` (md5 of current ticket ids and statuses), the current acknowledgment, the active handoff, `changed_since_handoff`, `readiness`, and (N15) `fulfilled` / `fulfillment_gap` from `order_fulfillment`. |
| `order_fulfillment` (N15) | every order | Planned loads, loads still to run, delivered loads without an accepted ticket, pending and accepted tickets, short and other-unit lines; `fulfilled` and the first `gap`. A fulfilled order can be billing-ready without being marked Completed. |

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
| `command_center_overview(kind, mine, limit, offset, hidden, mine_limit)` | same as the summary | The Command Center page in one call (20261120006400): `summary`, `urgent_by_kind`, `queue` and `mine` from one build of the exceptions list (`private.cc_exceptions`), identical to the separate calls, which now use the same helpers. |
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

## Platform owner, leads, demo and onboarding imports (N13)

Migration `20261024000100_platform_owner.sql`. All tables are in the `private` schema (no
direct access for app users); everything goes through the functions below.

| Table | Holds |
| --- | --- |
| `private.platform_admins` | The Taviron team: user, note, granted / revoked, `level` (`admin` or `support`, SA1). Not a company role. |
| `private.platform_staff_invites` | Team invitations (SA1): email, name, level, the link's SHA-256 hash only, expiry (7 days), accepted / withdrawn. |
| `public.support_access_grants` | A company owner's permission for Taviron support (SA1): 1, 3 or 7 days, ended early or by itself. Read through `support_access_status()` only (RLS on, no policy). |
| `public.membership_invitations` | A company's invitation to a person who already has a sign-in (security review M1, 2026-11-06): role, status (pending, accepted, declined, withdrawn). The person accepts through `answer_membership_invitation`; RLS on, no policy. |
| `private.support_change_requests` | Changes Taviron support asked for during a visit (SA2, `20261120009200`): kind, the action's stored arguments (only the fields it reads; never listed), plain summary and details, status pending → running → done/failed, or declined/withdrawn; expires after 3 days. Created by `support_change_request()` during a visit; listed by `support_change_requests()` (owners, visiting staff); a real owner claims it once (`support_change_claim`) and records the outcome (`support_change_finish`) or declines; the asker withdraws. All audited. |
| `private.delivery_proofs` | Verified deliveries (security audit L2, `20261120009300`): one-time proofs the server issues (`delivery_proof_issue`, service role only) after the email or accounting service confirmed a send; the person's request carries one in the `x-taviron-delivery-proof` header. Triggers on `invoices.sent_at`, `email_deliveries` (email channel, sent or test_sent) and `accounting_invoice_sends` (status sent, not simulated) refuse a signed-in person's success without a matching, unused proof from the last 10 minutes, and use it up. |
| `customer_payments`, `ticket_payment_applications` | Payments by delivery ticket (TP1, `20261120009400`): money a customer paid (amount, date, method, reference, note; voided with a reason, never deleted) and the tickets it pays (`handoff_order_id` + `ticket_number`, whole or part). A ticket's billed amount is its share of the billed handoff snapshot (`private.handoff_ticket_shares`: lines split by quantity, flat charges, tax and discount spread, exact to the cent, per billing business). Never more than a ticket's open amount, its issued invoice's balance or the payment; the rest is the customer's unapplied credit. With Taviron invoicing each application also creates an `invoice_payments` row (`customer_payment_id`), voidable only through `customer_payment_void`. RPCs: `customer_ticket_balances` (billing.view), `customer_payment_record` / `_apply` / `_void` (billing.manage); demo sample `demo_ticket_payment_samples`. |
| `order_documents` | Order documents (MK2, `20261120009500`): rate confirmation, bill of lading, proof of delivery or other, on an order and optionally one of its stops. Photos or PDFs (checked by content on the server), at most 10 MB and 30 per order, in the private `order-documents` bucket (service role only). `order_document_begin` (orders.edit; checks stop, type, size, count; reserves the path), `order_document_path` (orders.view; for a one-minute signed link), `order_document_remove` (orders.edit; kept with a reason). Audited. |
| `customers.is_broker`, `customers.mc_number` | Freight brokers (MK2, `20261120009600`): the broker is the invoiced customer; the shipper and receiver are the order's stops; `orders.customer_po` holds the broker's load number (shown as Broker load # / Load #). MC number: digits only, up to 8. |
| `private.support_sessions` | Taviron support visits (SA1): staff member, company, grant, reason, start, end. While open, `private.current_company_id()`, `has_permission()`, `current_app_role()` and `my_access()` resolve the visited company with owner permissions; never a membership, so staff are not listed, counted or emailed as people. |
| `private.platform_audit` | Append-only log of sensitive platform actions (grants, revocations, demo, company creation, import steps). |
| `private.leads` | Website demo requests and contact messages: kind, status (`new`, `contacted`, `demo_scheduled`, `demo_completed`, `converted`, `not_proceeding` — since 20261028000100), contact details, `truck_count` and `base_count` (required for new demo requests), `disposition` (`spam` flag, only on Not Proceeding; hidden from the queue), `onboarding_stage` (`in_progress`/`live`, only on Converted), `legacy_status` (the status before the consolidation, kept for reversal), owner, follow-up date, submission count. Older rows keep `role_title` and `fleet_size`. |
| `private.lead_emails` | Every confirmation/notification attempt for a lead: kind, recipient, mode (`preview`/`test`/`live`), status (`sent`/`failed`/`not_sent`), provider id, detail. Written only by `lead_record_email` (service role). |
| `private.lead_events` | Lead history: submitted, resubmitted, status / owner / follow-up changed, note added, company created. |
| `private.lead_attempts` | Keyed hash of the sender's address per submission (rate limiting); deleted after two days. |
| `private.import_batches` | One uploaded spreadsheet: company, entity (`customers`, `materials`, `trucks`, `drivers`), status (`review`, `approved`, `reverted`, `discarded`), column mapping, who/when, result. |
| `private.import_rows` | Each row: normalized data, status (`valid`, `error`, `duplicate`), messages, whether a duplicate may be overridden, decision (`import`/`skip`), created record id, outcome (`created`, `removed`, `kept_changed`, `kept_in_use`). |
| `public.companies.is_demo` | The company is a demo company (fictional data; never an import target). |

| Function | Who | Does |
| --- | --- | --- |
| `platform_admin_grant / _revoke(email, note)`, `platform_admin_list()` | service role (operator script) | The only way to change the platform team. Audited. |
| `lead_submit(lead, ip_hash)` | service role (`/api/leads`) | Validates, rate limits (5 / 15 min, 20 / day per address), merges a repeat from the same email into the open lead. |
| `platform_whoami()` | any signed-in user | Am I a platform admin? |
| `platform_leads(search, status, due_only)` (status `''` = all but spam, `'spam'` = spam only), `platform_lead(id)` (with history and email attempts), `platform_lead_update(id, status, owner, follow_up, spam, onboarding)`, `platform_lead_note(id, note)` | platform admin | Lead workspace; every change is a history event; the owner must be on the platform team. |
| `lead_record_email(lead, kind, recipient, mode, status, provider_id, detail)` | service role | Records one email attempt. `lead_submit` returns the lead id, whether it was new and whether a confirmation is due (at most one a day) — to the server only. |
| `platform_overview()`, `platform_team()`, `platform_audit_recent(limit)` | platform admin | Launchpad counts, team, audit log. |
| `platform_demo_start(timezone)`, `platform_demo_enter()` | platform admin | New demo company (earlier demos deactivated, never deleted), caller becomes its owner and switches to it. |
| `platform_companies()`, `platform_create_company(name, timezone, lead)` | platform admin | Customer companies (demos excluded) with counts; create one without users, optionally from a lead. |
| `platform_import_stage(company, entity, file, mapping, rows)` | platform admin | Stores rows for review (≤ 2,000), re-checks required fields and allowed values, flags duplicates against the company's records and earlier rows. Creates nothing. |
| `platform_import_decide(row, decision)`, `platform_import_discard(batch)` | platform admin | Reviewer's choice per row (errors never import; duplicates only where allowed); discard closes without creating. |
| `platform_import_approve(batch)` | platform admin | Creates the rows marked `import`, all or nothing (`tlt.platform_write` lets the customer-number trigger accept the target company inside this function only). |
| `platform_import_revert(batch, reason)` | platform admin | Removes records the batch created while untouched (no update in the audit trail) and unused; keeps and deactivates the rest; touches nothing else. |

## Maintenance (20261101000100)

| Table | Purpose | Access |
| --- | --- | --- |
| `work_orders` | Repair, inspection or preventive job on a truck; lifecycle reported → triaged → scheduled → in_progress ⇄ awaiting_parts → awaiting_inspection → completed → closed (or canceled); safety flag, clearance fields, `edit_seq`, `submission_key`. | Read `maintenance.view`; writes only through functions. |
| `work_order_events` | Append-only history (status, schedule, assignment, inspection, clearance, truck restricted/returned). | Read `maintenance.view`. |
| `work_order_costs` | Part, labor, vendor and other cost lines (quantity × unit cost in cents). Locked when the work order is closed or canceled. | Read/insert/delete `maintenance.costs` only. |
| `maintenance_schedules` | Preventive service per truck: interval days/miles/hours, warning windows, last done. | Read `maintenance.view`; write through `maintenance_save_schedule`. |
| `truck_readings` | Odometer / engine-hour readings; never lower than the latest; `source` and `source_id` say where each came from (20261120012200). | Read `maintenance.view`; write through `record_truck_reading` or the reading triggers (`private.feed_truck_reading`). |

Rules: a trigger on `trucks` refuses a return to service while an open safety-critical work order exists; one
open work order per schedule (unique partial index); work order numbers come from the `work_order` document
sequence. Functions: see IMPLEMENTATION_PLAN §5w.

### Shop records and fixes (20261120012000–20261120012600)

- **Units held by safety work orders (012000, bug fix).** `work_orders.restricted_truck` now marks every open
  safety-critical order that holds its truck or trailer out of service, not only the first: a second one joins the hold
  (`private.wo_restrict_truck`), and clearing, canceling or downgrading a holding order passes the hold to the orders
  still open (`private.wo_release_truck`). The unit returns to service when the last holding order clears; a unit a
  person took out of service by hand (no order holds it) is never returned automatically. The stored
  `out_of_service_reason` is rewritten to name the open safety-critical orders (`private.wo_hold_reason`, the same words
  as `currentRestrictionReason` in the app). The migration repaired units stuck by the old behaviour (the hold moved to
  their open orders); units with no open safety order left were not returned to service automatically.
- **Triage never lowers urgency (012100).** `maintenance_decide_triage('accepted')` keeps the higher of the current and
  suggested urgency and never clears the safety flag (the app's `acceptTriage`).
- **Readings from every entry (012200).** `truck_readings.source` (`manual` | `inspection` | `trip_sheet` | `fuel` |
  `work_order`) and `source_id`. Triggers on `vehicle_inspections`, `trip_sheets` and `fuel_purchases` (not voided) and
  on the work order's at-service odometer and engine hours call `private.feed_truck_reading`: a reading never lowers the
  current one; a lower value or an impossible jump (over 2,000 miles or 24 engine hours per day since the last reading)
  is not used and is written to `audit_events` (`truck.reading_ignored`, on the truck). Preventive status
  (`private.pm_due`) therefore follows real mileage. `record_truck_reading` (Preventive page) is unchanged.
- **Parts on order (012300).** `work_order_part_waits`: work order, optional stock `part_id`, description, part number,
  quantity, vendor, PO number, expected date, expected unit cost (column not granted: read through `part_waits()` with
  `maintenance.costs`), status `waiting` / `received` / `canceled`, received by/at, cancel reason, submission key. Read
  with `maintenance.view`; written only by `part_wait_add` (optionally moves the job to awaiting parts),
  `part_wait_update`, `part_wait_receive` (a stock part is received and used on the job through `part_movements` with
  the same cost line as `part_use`; a one-off part with a known cost becomes a part cost line; optionally back to the
  queue), `part_wait_cancel` (all `maintenance.manage`, through `private.wo_for_crew`). Lifecycle: reported, triaged
  and scheduled may go to awaiting parts; awaiting parts may go back to triaged. `demo_part_wait_samples()` (demo owner).
- **Annual inspection (012400).** `maintenance_record_inspection(work_order, p)` (`maintenance.manage`; a completed or
  closed `inspection` work order): archives the unit's current `inspection` vehicle documents and records the new
  certificate (inspected on, expires on, inspector as `issuing_authority`, reference; not verified), keyed by the work
  order (`submission_key`) so recording again corrects it. The report photo uses `work_order_photos`.
- **Outside repairs (012500).** `work_order_costs.invoice_number`, `invoice_date`, `warranty_until` (vendor lines only;
  warranty not before the invoice), with the existing insert grant (`maintenance.costs`). `vendor_warranties()`
  (`maintenance.view`, no amounts) lists repairs still under warranty. `demo_outside_repair_samples()` (demo owner).
- **Return to stock (012600).** `part_movements.kind` gains `returned` (positive quantity, `returned_from` = the use it
  reverses; never more than was used). `part_return(use, quantity, reason)` (`maintenance.manage`; not on closed or
  canceled work orders) adds the movement, puts the part back on hand and, when the use carried a cost, a credit line
  (`work_order_costs.returned_movement_id`, negative quantity, allowed only on such lines and not removable by hand).

The weekly shop report (`/maintenance/weekly`) needs no table: it reads work orders, labor time, part cost lines,
`equipment_status_events` and preventive status with the person's own access.

## Fleet management (20261102000100)

| Table / column | Purpose | Access |
| --- | --- | --- |
| `vehicle_documents` | Registration, insurance, inspection, permit, lease, title and other documents per truck or trailer: number, issuer, issued/expires dates, notes, `archived_at`. Metadata only. | Read `fleet.view`; insert/update `fleet.edit`; no delete. |
| `truck_assignment_events` | History of drivers' primary trucks (assigned / unassigned, who, when), written by a trigger on `drivers`. | Read `fleet.view`. |
| `trucks.ownership`, `trailers.ownership` | owned / financed / leased / rented; NULL = not recorded. | Update `fleet.edit`. |

Function: `assign_truck_driver(p_truck_id, p_driver_id)` — `fleet.assign`; atomic assign/reassign/remove.

## Communications (20261105000100–0400)

See docs/COMMUNICATIONS.md for behaviour. All tables carry `company_id` and RLS; writes only through functions.

| Table | Purpose | Read access |
| --- | --- | --- |
| `comm_settings` | Company rules (edit window, history policy, retention, legal hold, away threshold, delivery notifications, archive delay). Audited. | Company members |
| `conversations` | direct / group / channel / operation; title, department, status active/closed/archived. | Members (current or former) |
| `conversation_members` | Membership periods: `joined_at`, `history_from`, `left_at`, role, source (manual/dispatch/creator), mute, delivered/read marks. | Members |
| `messages`, `message_revisions` | Messages (text/system, one level of replies, pinned, client key, edit/delete marks, `removal_kind` author/manager, `expired_at` after the 14-day retention); originals of edits and deletions with the manager's removal `reason` (deleted when the message expires). | Visible history within 14 days (legal hold: all); revisions `comms.admin` |
| `conversation_events` | Membership, title, sync and lifecycle history. | Members |
| `user_presence`, `comm_preferences`, `comm_notifications` | Presence choice and last activity; personal notification settings and quiet hours; in-app notifications (visible / deferred / superseded). | Company / own / own visible |
| `announcements`, `announcement_revisions`, `announcement_receipts` | Announcements (all or one department, acknowledgment), earlier versions, read/acknowledged marks. | Published + audience; revisions and others' receipts `comms.announce` |
| `operation_workspaces`, `comm_housekeeping_runs` | Workspace scope (orders / site + date / loads), sync status; throttle for housekeeping. | Members or `comms.operations`; company |
| `alert_event_types` (global), `comm_alert_settings`, `alerts`, `alert_recipients`, `alert_acknowledgments`, `alert_events` | Alert catalog with safety minimums; company policies (audited); alerts with dedup key, priority, scope, escalation; recipients and responsibility; acknowledgments; history. | `comms.alerts` or recipients |
| `message_attachments` | File records (pending → uploaded → attached / discarded; `expired` with `expired_at` and `file_removed_at` once retention removed the stored file) for the private `comm-attachments` bucket. | Those who can read the message |
| `telematics_settings`, `vehicle_positions`, `driver_hours` | GPS and hours (B101): the company's source (none / manual / feed), current-for minutes and feed key hash (never readable; `telematics_status()`); truck positions and driver duty status and clocks, each with source (manual / feed / demo) and time. | Settings: service only. Positions and hours: `dispatch.view` or `fleet.view`; a driver their own hours |
| `revenue_leak_reviews` | Revenue check (B110): findings a person marked as fine, by finding key (which includes the amount, so a changed amount reappears), with the reason and who. Findings themselves are computed by `revenue_leaks()`, never stored. | `billing.view` read; written only through `revenue_leak_check` / `revenue_leak_reopen` (`billing.manage`) |
| `wait_time_settings`, `load_stop_times` | Wait times (B111): the company's free minutes (null = none flagged); per load and stop (pickup / site) the arrival and departure, the pickup location, and the source (driver / office / demo). Track only: nothing is billed. | Read: `dispatch.view` or `billing.view`, or the load's own driver. Write: `load_stop_mark` (own driver or `dispatch.edit`), `load_stop_mark_at` (the same people; a time tapped without signal and sent later, at most 16 hours back, never in the future — 20261120006100), `load_stop_set` (`dispatch.edit`), `wait_time_save_settings` (`settings.manage`) |

## Customer self-booking (20261120005500)

| Table | Purpose |
| --- | --- |
| `booking_settings` | Per company: `enabled` (default off), `min_days_ahead`, `horizon_days`. Read by members; saved by `booking_save_settings` (`settings.manage`). |
| `booking_capacity` | Loads customers may request per company and day (0 = closed). `booking_set_capacity` (`dispatch.edit`); read with `dispatch.view`. |
| `booking_requests` | A customer's request: day, loads, material, optional saved site, time of day, notes, status `pending/approved/declined/canceled`, decision note, linked order. Read with `dispatch.view`; customers use `portal_booking_state/request/cancel` only. |

## Credit holds (20261120005600)

`customers` gains `credit_hold`, `credit_hold_reason`, `credit_hold_at`, `credit_hold_by`, `credit_limit_cents`.

| Table | Purpose |
| --- | --- |
| `credit_hold_settings` | Per company: `overdue_days` (null = automatic holds off). `credit_hold_save_settings` (`billing.manage`). |
| `credit_hold_overrides` | Each time someone created an order or dispatched a load for a customer on hold: context, record, reason, the hold's reasons, who and when. Read with `billing.view`; written only by `record_credit_override` (`orders.edit` / `dispatch.edit`). |

`private.credit_holds` computes who is on hold (manual, overdue past the set days, open issued invoices over the limit);
`customer_credit_holds` returns it to order, dispatch and customer staff (amounts only with `billing.view`).

## Hauler settlements (20261120005700)

`haulers.commission_bp` (0–5000). `hauler_settlements` (number, hauler, period, status draft/approved/paid/void, gross,
frozen commission rate and amount, deductions, net, paid date and reference, void reason), `hauler_settlement_jobs`
(snapshot of each settled confirmed offer: quantity, unit, rate, amount; `released` when its settlement is voided; an
offer is in at most one unreleased row), `hauler_settlement_deductions` (description, amount, `removed`). Read with
`payroll.manage` or `billing.view`; every change through `hauler_*` functions (`payroll.manage`).

## Fuel and IFTA (20261120005800)

`fuel_purchases` (truck, driver, day, state/province, gallons, total, odometer, station, receipt number, void + reason) and
`trip_sheets` (truck, driver, day, start/end odometer, `legs` = miles per state summing to the difference; one live sheet
per truck and day; void + reason). Fleet staff read all; a driver reads their own. Written by `fuel_record_purchase` /
`fuel_record_trip_sheet` (fleet.edit, or a driver for a truck they drove that day or their own truck); `fuel_void`
(fleet.edit); `fuel_my_trucks(day)` for My Day. The quarter's IFTA summary is computed in `src/lib/fuel/ifta.ts`.

## Vehicle inspections (20261120006000)

`vehicle_inspections` (truck, driver, kind `pre_trip`/`post_trip`, day, odometer, `items` = every DVIR item with OK and
a note, defect count, `safety_defect`, remarks, `work_order_id`; one per truck, day and kind). Fleet or maintenance staff
read all; a driver reads their own. Written only by `inspection_submit` (fleet.edit, or a driver for a truck they drive
today or their own truck — the fuel rule): defects open one work order (`source = 'inspection'`, a new value of the
work-order source check); a safety-item defect makes it safety-critical and takes the truck out of service
(`private.wo_restrict_truck`). `inspection_my_trucks()` for My Day; `inspection_missing_today()` (fleet or dispatch
view) lists today's working trucks without a pre-trip. Missing inspections never block dispatch. Since 20261120006100
`inspection_submit` takes an optional `inspected_on` (today or yesterday) for inspections saved on a phone without
signal and sent later.

## Work order photos and dump-body items (20261120006700)

`work_order_photos` (work order, path in the private `maintenance-photos` bucket, type, size, uploader). Maintenance
viewers read them; nobody reads the bucket directly (the server's service role stores and signs one-minute links).
Reserved only by `work_order_photo_begin` (maintenance.manage, open work orders, through `private.wo_for_crew`) and
`inspection_photo_begin` (the driver who recorded the inspection, that day, while its work order is open; or
maintenance.manage). JPEG/PNG/WebP, at most 5 MB, at most 8 per work order. `work_order_photo_path` answers maintenance
viewers or the uploader. `private.inspection_items_for(truck)` is the DVIR list plus five dump-body items on dump
trucks (`truck_type` ending in `_dump`; not safety items); `inspection_submit` checks that list and
`inspection_my_trucks` adds a `dump` flag.

## Accountant access (20261120006200, 20261120006300)

`company_memberships` gains `access_ends_at` (required for the role `accountant`) and `payroll_view` (accountants
only). `private.current_company_id()` and `current_company_id_any()` ignore a membership whose `access_ends_at` has
passed, so an ended accountant reaches nothing. The role `accountant` may hold only `accounting.view` and `billing.view`
(trigger `role_permissions_accountant_guard`). Owners only (`private.require_owner`): `accountant_grant`,
`accountant_set_access` (extend, payroll on/off, end now), `accountant_list`. `accountant_me`,
`accountant_record_visit` (audit `accountant.visited`), and payroll for an accountant whose invite includes it or
payroll staff: `accountant_payroll_periods`, `accountant_pay_statement` (approved periods only). Fuel purchases and trip
sheets are also readable with `accounting.view`.

## Support center (20261120006800)

Builds on the portal's `portal_support_requests` and `portal_messages` (20261120000700). A case gains `kind`
(`delivery`, `billing`, `material`, `other`), `assigned_to`, optional `ticket_id` and `invoice_id` (beside `order_id`;
each must belong to the case's customer), `opened_by_staff` (office-opened cases have no `account_id`),
`first_reply_at` and `closed_at`. A message gains `internal` (staff notes; never returned by the `portal_*` functions).
`portal_support_files` holds attachments (photos and PDFs, 10 MB, 5 per message) in the private `support-files`
bucket; `support_settings.first_reply_hours` is the company's target (null = off). Customer writes:
`portal_support_open`, `portal_support_send` (a closed case reopens only within 14 days of closing; the original
`portal_support_reply` follows the same rule), `portal_support_file_begin`. Staff writes (customers.edit):
`support_open_case`, `support_reply` (reply, internal note, close), `support_update`, `support_file_begin`;
`support_save_settings` (settings.manage). Reads: RLS on customers.view; `support_overdue()` for the Command Center;
`support_notice_recipients()` for the email notice the app sends (never from a demo).

## One invoice for several orders (20261120007000)

`invoice_orders` lists every order an invoice bills (`invoice_id`, `handoff_order_id`, `order_id`, `order_number`,
`position`, `total_cents`, `active`); existing invoices were backfilled with their one order. A unique index on
`handoff_order_id where active` allows one active invoice per handed-off order, alone or combined; triggers on
`invoices` list the invoice's first order on insert and set `active = false` when it is voided. `invoices.order_number`
holds the list of order numbers for a combined invoice, and each line carries its `order_number` and names it in the
description. Writes: `invoice_create_combined(handoffs[])` (billing.manage; one customer, Taviron issuing, none undone,
invoiced or sent to QuickBooks; locks the handoffs). Reads: RLS on billing.view; `invoice_combine_candidates()`
(security invoker). The dates check on `invoices` now applies to numbered invoices only, so a draft can be discarded.

`my_shift_offer_audiences()` (20261120007100): who each of the caller's own visible shift offers is for, so My Day
lists driver and everyone offers and My jobs shop and everyone offers. Read-only.

## Accessibility settings (20261120007300)

`user_accessibility` (personal, not business data, like `profiles`): one row per signed-in person (staff and portal
accounts), `settings` jsonb with `textSize` (100, 115, 130), `highContrast`, `reduceMotion`, `readableFont`. Readable
only by its owner; written only through `set_my_accessibility(settings)`, which keeps the four known keys and validates
them.

## Industry profile (20261120007600)

`company_settings.industry`: `aggregate` (default), `freight` or `both`. Changes words in the app (delivery tickets or
bills of lading), never rules. Updated through the existing company settings policy (settings.manage).

`company_settings.hidden_areas` (20261120007700, simple mode): optional menu areas the company hid; a check allows only
the nine optional areas, so safety areas can't be hidden. Menu only.

## Stops on an order (20261120007800, MK2 slice 1)

| Table | Purpose |
| --- | --- |
| `order_stops` | An order's stops in order (`seq` 1–25): `kind` (`pickup` / `delivery`), place `name`, address (`address_line1`, `city`, `state`, `postal_code`), `appointment_date` with an optional `window_start` / `window_end` (both or neither, end after start, needs a date), `reference` (pickup number, PO, BOL), `notes`. `removed_at` marks a stop taken off the order (never deleted). Read with `orders.view` or `dispatch.view`; no client writes. |

- `save_order_stops(order, stops jsonb)` (`orders.edit`): replaces the order's current stops with the list in order (ids of current stops are kept and updated, others added, the rest marked removed); the first stop must be a pickup and the last a delivery; refused on completed and canceled orders and for other companies' orders; audited as `order.stops_saved`.
- `driver_load_stops()`: the signed-in driver's own loads (two days back to tomorrow) keyed by load, each with its order's stops in order and a one-line address.
- Aggregate orders without stops keep the order's pickup (`pickup_location_id`) and job site; the order page shows the Stops section for companies hauling freight (`company_settings.industry`) or when stops exist.

## Subscription notices (20261120008800, SUB1)

Private (platform) tables: `subscription_events` (one row per company, kind and period; customer `notice_status`
pending | sent | previewed | failed | not_needed), `subscription_grace` (one open grace per company),
`tier_changes` (due → scheduled → applied, or canceled; one open per company); `company_lifecycle.renewal_off`.
`private.subscription_run_core` (daily, idempotent) is called by `subscription_run_cron` (service role, from the
lifecycle cron) and `platform_subscription_run` (platform admins). Platform functions: `platform_subscription_state`,
`platform_set_renewal`, `platform_tier_change_schedule` (later date and agreed price required), `platform_tier_change_cancel`
(reason required). Service-role only: `subscription_pending_notices` (with owner emails), `subscription_notice_mark`.

## Trucks for the day (20261120008600, UX11)

- `orders.job_type` (`loads` default | `truck_day`) and `orders.truck_billing` (`tickets` | `hours`). Changing the job
  type is refused once the order has live tickets (`set_order_job_type`, orders.edit, audited).
- A truck for the day is an `order_loads` row without a planned quantity (a slot), planned in one step by
  `truck_day_plan(order, date, trucks, start, end, note)` (dispatch.edit; through `save_order_load`) and assigned with
  `assign_load` as any load. Tickets are trips: `private.prepare_ticket` skips the "already has a ticket" confirmation
  on truck-day slots.
- `order_loads.released_at / released_by / release_source (dispatch | driver | site) / release_note`. Release ends the
  active assignment at that moment (frees the truck and driver for a later job; overlap rules unchanged). Callers:
  `truck_day_release` (dispatch.edit, or the slot's own driver) and `portal_truck_release` (the customer's own order);
  the shared core is `private.truck_day_release_core`. Not before the planned start; once only.
- `truck_hours_settings` (company; `basis` null = off, `scheduled` | `arrived`; `minimum_hours`; `shortfall`
  `bill_minimum` | `review`), saved by `save_truck_hours_settings` (billing.manage).
- Read functions: `truck_day_hours(order)` (billing.view; per truck: start by the basis, release, trips, hours,
  billable, short, missing reason; rate from the order's hourly line, else the customer's then standard price list
  hourly hauling rate; nothing estimated), `driver_truck_days()` (the caller's own slots), `portal_order_trucks(slug,
  order)` (today's trucks of the customer's own order; truck unit only, never the driver).
- Rollback restores `private.prepare_ticket` (20261022000100) and removes the functions, table and columns.
- 20261120008700: `truck_day_hours` names the driver from their sign-in profile when the driver record has no name
  (as tickets do) and reports `billed` per truck; `order_loads.truck_hours_line_id`; `truck_hours_apply(order)`
  (billing.manage) adds one hourly line (charge item TRUCK-HOURS, billed without a ticket) for the counted trucks not
  billed yet, recomputes totals under `tlt.billed_extra`, marks the trucks, audits. Rollback restores the 008600 function.

## Portal: delivered and left per ordered line (20261120008500, UX5)

`public.portal_order` returns, for each ordered line, `tracked` (billed from delivery tickets: per-unit, not a
discount, and its charge item is not ticketless), `delivered` (live tickets for the line in the line's unit:
submitted, being checked or confirmed), `confirmed` (accepted only) and `remaining` (ordered minus delivered, never
below zero). Counted exactly like `billing_line_status`; tickets in another unit are not added. Nothing else changes;
the rollback restores the 20261120000700 definition.

## Extra charges after the work (20261120008400, MK2)

- `public.order_add_charge(order, charge_item, quantity, unit_rate_cents, note)` (billing.manage): only active per-unit
  charges with `ticket_required = false`; scheduled or completed orders before the billing handoff; uses the same
  `tlt.billed_extra` exception as detention; audited (`billing.charge_added`).

## Import: job sites, trailers, driver credentials (20261120008300, LR3)

- `private.import_batches.entity` also accepts `sites` and `trailers`; `private.import_fields`, `import_stage_core`,
  `import_approve_core` and `company_import_undo` handle them. Sites match exactly one existing customer by name
  (case-insensitive); drivers may carry `cdl_class` / `cdl_state` / `cdl_expires_on` / `medical_expires_on`, created as
  unverified `driver_qualifications`. The platform revert (deletes) is refused for the new kinds in the app; the company
  undo (made inactive) covers them.

## Detention and charges billed without a ticket (20261120008200, DT1)

- `charge_items.ticket_required` (default true): false for per-occurrence charges; `billing_line_status` leaves their
  order lines out, so they never wait for a ticket.
- `customers.detention_free_minutes`, `customers.detention_rate_cents`: both or neither (`customers_detention_pair`).
- `load_stop_times.detention_status` (`applied` / `dismissed`), `detention_order_line_id`, `detention_reason`,
  `detention_decided_by`, `detention_decided_at`: each stop is decided once.
- `private.detention_rows(company, order)` computes every proposal (wait in whole minutes, billable = wait minus free,
  hours rounded to 0.01, amount = hours x rate rounded to the cent); `detention_proposals(order)` (billing.view),
  `detention_apply(stop_time)` and `detention_dismiss(stop_time, reason)` (billing.manage). `detention_apply` sets
  `tlt.billed_extra` for its own transaction, the one exception to the confirmed-order guards: an inserted line and the
  totals it changes (never an update or delete of a line, never the customer, tax rate or terms).

## Freight equipment and places (20261120008100, MK4)

- Enum values `truck_type.straight_truck` and `trailer_type.dry_van`, `reefer`, `step_deck` (additive; the app offers
  each company only the types for what it hauls, `src/lib/fleet/labels.ts`). `company_locations.kind` also accepts
  `shipper`, `receiver` and `warehouse`. `private.import_stage_core` accepts `straight_truck`.
- `public.demo_freight_sample_wording()` (definer, demo owner only): rewords the exact sample text of portal bookings,
  the shift offer and safety findings when the demo hauls freight. `public.demo_support_samples()` writes its cases in
  freight words for a freight demo (support messages are append-only, so they are never reworded afterwards).

## Arrived / Left at each stop (20261120008000, MK2 slice 2)

- `load_stop_times.order_stop_id`: a stop's times use the key `stop:<order stop id>` in `stop` (check: `pickup` and
  `site` without a stop, or the key matching `order_stop_id`). `private.order_stop_for(order, key)` accepts only a
  current stop of the load's order. `load_stop_mark`, `load_stop_mark_at` and `load_stop_set` take the key; pickup and
  job site work as before. `driver_load_stops()` returns each stop's `id`.

## Driver, invoice, portal and Command Center fixes (20261120011000–20261120011600, owner 2026-11-09)

- `load_stop_undo(load, stop, event)` (`20261120011000`, definer): the load's own driver takes back their last Arrived
  or Left tap (their own, source `driver`, today, at most 10 minutes old; Left before Arrived; not once the office
  decided detention). The row stays: the time is cleared and the next tap records again. Audited
  (`wait_time.undone`). The office corrects with `load_stop_set` as before.
- `field_report_photos` (`20261120011100`): photos on a driver's report (JPEG, PNG, WebP, 5 MB, at most 4, within an
  hour of sending), in the private `field-report-photos` bucket (service role only). `field_report_photo_begin`
  (definer; the reporting driver; reserves the path), `field_report_photo_path` (invoker: visible exactly when the
  report is, base scope included; for a one-minute signed link). A failed upload is kept with `failed_at` and never
  shown. Read: the report's own policies.
- `invoices.sent_via` (`email` / `manual`), `sent_how` (`mail` / `own_email` / `handed_over` for manual), `sent_by`
  (`20261120011200`). `invoice_mark_sent(invoice, how)` (billing.manage, issued only; returns false when already sent)
  records a send the person made themselves, never as emailed (history `invoice.marked_sent`). The delivery-proof
  guard lets `sent_at` through without a proof only for that path (manual, no addresses, a transaction mark only the
  function sets); `invoice_record_sent` now sets `sent_via = 'email'`.
- `private.prepare_ticket` (`20261120011300`): the ticket snapshot's driver name follows `driver_list` (a demo
  company's driver record name first, else the login's profile name, else the record's name).
- Truck-only swap (`20261120011400`): a reassignment with the same driver, load and times raises one
  `dispatch.assignment_truck` notice ("Truck changed: …", new and old equipment) instead of a cancel and a new load
  (`private.is_truck_only_swap`). The cancel notice trigger `alerts_assignments` is a deferred constraint trigger (runs
  at commit, after the replacement exists).
- Portal (`20261120011500`): `portal_support_link_options` tickets carry `delivered_at`, `quantity`, `unit`;
  `portal_sites` lists each site's `pending_notes` (gate code, drop spot, contact, phone, notes, photo count,
  `created_at`). The signed-in customer's own records only, as before.
- Command Center (`20261120011600`): a past load no truck ran (no assignment and no voided ticket) is an
  `unassigned_load` item (priority 2, `details.past = true`, reason `not_assigned` or `assignment_removed`, key
  `unassigned_load:<load>`) for Dispatch instead of a `missing_ticket`; the summary's `unassigned_loads` counts today's
  loads only.

## Communications read speed (20261120007900)

- `private.my_alert_ids()` returns the alerts the signed-in person is a recipient of; the read policies of `alerts`, `alert_recipients`, `alert_acknowledgments` and `alert_events` use it once per query instead of `private.alert_is_recipient` per row (same access). Index `alert_recipients_user_idx (user_id, company_id, alert_id)`.
- `comm_inbox()` applies the message visibility rule inline (company, retention cut-off and legal hold read once) instead of calling `private.comm_message_visible` per message. Same results.

## Planned tables (later phases)

Maintenance and work orders, drivers, dispatch assignments, route plans and
stops, delivery tickets and ticket lines, planning runs, integration records
(QuickBooks IDs, sync status, errors).

# Smart Load Build — specification

Status: **increment 1 implemented** (draft loads from an order's quantity, dispatcher approval). Everything else
below is specified, not built. Linked from `docs/TAVIRON_MASTER_PLAN.md`. Questions marked **[open]** are product
decisions still with the founder; the dependent feature must not ship before they are answered.

## 1. Accepted requirements (confirmed by the founder; do not re-ask)

| | Requirement | Status |
| --- | --- | --- |
| A | Build loads and plan the hauling: individual loads, trucks and trips needed, when the work happens | Partial: loads + dates (increment 1); trucks/trips via Smart Dispatch |
| B | Optimize the whole plan (payload, truck/driver availability, deadlines, travel time, cost, workload) — not payload or trip count alone | Missing (needs cycle times, cost data) |
| C | Exact quantities: 93 t at 25 t → 25, 25, 25, 18; never over-deliver; consistent precision | **Done** (thousandths, invariant checked) |
| D | Flexible windows: spread across the whole permitted window; firm dates stay firm unless an authorized user approves | Partial: even spread across the scheduled days; never moves dates; no firm/flexible flag yet |
| E | Cycle time: loading, outbound, unloading, return, shift limits, existing commitments | Missing (no travel or site data; dispatcher states loads per day) |
| F | Balanced optimization; legal, safety, payload and qualification constraints never traded for score | Hard constraints enforced; no optimization score yet |
| G | Truck eligibility filtered automatically; dispatcher may override configurable non-legal restrictions with a warning and recorded reason; revalidate; never override legal payload or safety | Partial: capacity, service status, safety reports, active; no overrides yet |
| H | Material, grade, quarry/source and customer restrictions; approved alternative quarries with trade-offs, change only with authorization; never substitute silently | Missing (no quarry/source data model) |
| I | Coordinate compatible orders; multi-order trips when permitted; each customer's quantities, tickets and billing stay separate | Missing |
| J | Actionable proposal for review; nothing committed silently; conflicts explained; dispatcher approves before commitments | **Done** for increment 1 (draft → approve → planned loads; assignments still approved separately in Smart Dispatch) |

## 2. What already exists (code locations)

- **Orders:** `orders` (scheduled_start/end = date range; window_start/end = daily time window; requested_date),
  `order_lines` (`material_id`, `quantity numeric(12,3)`, `unit_code`). Status rules: `src/lib/orders/status.ts`.
- **Loads:** `order_loads` (`planned_quantity numeric(12,3)` + `unit_code`, date, start/end time, status
  planned/canceled), written only by `save_order_load` / `cancel_order_load` (`dispatch.edit`): checks order status
  (scheduled … partially completed), dates inside the scheduled range, 3-decimal precision, company units.
- **Trucks:** `trucks.weight_capacity` + `weight_unit` (ton/lb), `volume_capacity` (cu_yd), `capacity_verified_at`,
  `service_status`, `active`. Driver reports (`field_reports`) of breakdown/inspection problems block a truck.
- **Assignment:** Smart Dispatch (`src/lib/dispatch/smart.ts`, `src/server/data/smart-dispatch.ts`,
  `src/components/dispatch/smart-dispatch.tsx`) proposes a truck + driver per planned load; `assign_load` re-checks
  eligibility, capacity, conflicts (exclusion constraint), and a dispatcher approves.
- **Downstream:** tickets per load, fulfillment and billing readiness (`src/lib/billing/rules.ts`) use
  planned/delivered quantities per order — Load Build feeds them without changes.

## 3. Data available vs missing

| Available | Missing (needed for later increments) |
| --- | --- |
| Order quantity, unit, material, date range, daily window | Firm vs flexible date flag; deadline per order **[open: who may change firm dates?]** |
| Truck capacity (weight/volume), verification, service status, safety reports | Legal gross/axle limits per truck/route; truck–material compatibility; site access restrictions |
| Driver qualifications, assignments | Driver shift/hours limits **[open: which rules apply — FMCSA HOS, company limits?]** |
| Job site address | Quarry/source records, distances, travel and load/unload times **[open: data source — manual table or a routing service (paid; needs approval)?]** |
| Prices per material/customer | Cost per truck-hour/mile **[open]**; approved alternative sources per material **[open]** |

## 4. Rules

- **Quantity conservation:** quantities are integers in thousandths (`numeric(12,3)`); full loads at the payload,
  then one partial load; the sum equals what is left to plan exactly (asserted). Left to plan = ordered quantity of
  the single material line − planned (non-canceled) loads in the same unit. Loads without a quantity are listed as
  not counted. Planned more than ordered → no draft, with a warning.
- **Scope of increment 1:** one material line in tons or cubic yards. Several material lines → refused with a
  message (per-material loads need a material on the load **[open: one material per load, or mixed?]**). Charge
  lines (hauling per ton etc.) are never split into loads.
- **Payload:** chosen by the dispatcher; the offered choices are the recorded capacities of usable trucks. A draft
  is refused when no usable truck can carry the payload. Unverified capacities → warning.
- **Eligibility (increment 1):** active, in service, no open breakdown/inspection report, capacity recorded in the
  order's unit. Driver qualifications and conflicts are checked at assignment (Smart Dispatch / `assign_load`).
- **Dates:** only the order's scheduled days from today on; "even" (default) spreads across all days, "earliest"
  fills days in order; loads per day come from the dispatcher. If the loads do not fit, the draft is refused and
  dates are **not** moved. Times: the order's daily window, else the dispatcher's start/end. Loads on one day share
  that window (each needs its own truck until trip times exist) — stated as a warning when trucks are short.
- **Overrides (later):** only configurable, non-legal restrictions; warning + required reason, recorded in the audit
  log; the plan is re-validated after the override; legal payload and safety restrictions cannot be overridden.
- **Alternative sources (later):** proposed with trade-offs (distance, availability, price); applied only with the
  authorization of a user with **[open: which permission — orders.edit?]**; customer restrictions always win.
- **Multi-order trips (later):** only compatible material, within payload and every delivery window, where the
  customers permit it **[open: per-customer permission field]**; quantities, tickets and billing stay per order.

## 5. Review, approval, revalidation

1. The dispatcher opens **Build loads** from the order (`/orders/[id]/load-build`, `dispatch.edit`).
2. The draft is computed on the server from the database (never from client figures) and shown with blockers and
   warnings. Showing a draft writes nothing.
3. **Approve** recomputes the draft from current data; if it differs from what was reviewed (another load, a truck
   change), the approval is refused and the new draft must be reviewed. Loads are created through
   `save_order_load`; if any fails, the loads created by that approval are canceled again (no partial plan).
4. No truck or driver is assigned. Assignments remain a separate, approved step (Smart Dispatch).

## 6. Security and tenancy

- Reads use the caller's session: RLS limits orders, lines, loads, trucks and reports to their company; another
  company's order id gives "not found". Writes go through `SECURITY DEFINER` functions that re-check company and
  `dispatch.edit`. The page requires `dispatch.edit` (server-side). All inputs validated with zod on the server.
- No migration in increment 1. Later increments that need tables (sources, cycle times, overrides) get a migration,
  a rollback script and owner approval before any remote application.

## 7. Tests and acceptance

- Unit (`tests/unit/load-build.test.ts`): 93 → 25/25/25/18; fractional exactness; remaining after planned loads;
  over-planned; capacity limit; inactive/out-of-service/unsafe/unknown trucks; unit mismatch; lb→t; warnings; even
  vs earliest; firm dates not moved; missing inputs.
- Browser (`tests/e2e/load-build.spec.ts`): review creates nothing; approval adds exactly 25/25/25/18 over three
  days with no assignment; nothing left afterwards; stale review refused; no access without `dispatch.edit`;
  another company sees "Not found".

## 8. Milestones

1. **Done:** draft loads from one material line, payload and daily count from the dispatcher, approval.
2. Cycle-time inputs (per order or site: load, travel, unload, return) → staggered start times, trips per truck per
   day, shift limits. Needs **[open]** data-source decision.
3. Firm vs flexible windows + authorized date changes.
4. Overrides with recorded reasons (configurable restrictions only).
5. Quarry/source model, compatibility and alternative-source recommendations with authorization.
6. Multi-order trips with per-customer permission.
7. Balanced objective (cost, utilization, workload) once 2–6 provide the data — never at the expense of hard rules.

Risks: travel-time precision without real data (avoided: no estimates are shown); dispatcher-entered daily counts can
be optimistic (warned against truck count); shared staging database between Preview and Production.

## 9. Increment 2 — trip and cycle-time planning (audit and proposal, 2026-10-11)

### 9.1 What the data holds today (audited in the schema and code)

| Need | In Taviron today | Status |
| --- | --- | --- |
| Loading duration | Nothing (no quarry/source records) | **Missing** |
| Travel time to site | Order and customer-site addresses only; `customer_sites.latitude/longitude` exist but are empty (0 of 153 locally) and no screen fills them; no origin (quarry/yard) location at all | **Missing** |
| Unloading duration | Nothing | **Missing** |
| Return / repositioning | Nothing | **Missing** |
| Truck availability | `active`, `service_status`, `expected_return_date`; open breakdown/inspection reports; active `dispatch_assignments` intervals (no-overlap constraint) | **Stored** |
| Driver availability | Active flag, qualifications with expiry, assignment intervals; no time off, shifts or availability | **Partial** (time off is part of the future Employees area) |
| Shift limits / driver-hour rules | Nothing; no rule is assumed | **Missing — decision needed** |
| Delivery windows | `scheduled_start/end` (dates), `window_start/end` (daily time), `requested_date`, urgency `needed_by` | **Stored** |
| Firm vs flexible dates | Nothing; every scheduled date is treated as firm | **Missing — decision needed** |
| Observed timings | `delivery_tickets.delivered_at` per ticket and truck (could yield measured turnaround between a truck's deliveries); driver "delay" reports are free text without durations | **Usable later as "measured"** |

### 9.2 Implemented now (not wired to any page)

`src/lib/dispatch/trip-plan.ts` with `tests/unit/trip-plan.test.ts` (10 tests). Pure logic only:
- a trip = load + outbound + unload + return minutes; each duration carries its source (`dispatcher`, `measured`,
  `estimate`) and estimates are called out;
- `maxTripsPerTruck`: trips one free truck can deliver inside the window (and the shift, when entered);
- `planTrips`: places a day's loads (exact quantities from increment 1) on usable trucks that can carry them, never
  overlapping existing bookings, delivery (arrival → unloaded) inside the window, finished within the shift;
  anything that does not fit is returned as unplanned with the reason — never squeezed in or moved to another day.
  The truck pairing is for feasibility only: no assignment is created; Smart Dispatch + dispatcher approval remain.

### 9.3 How cycle times change the plan

- One truck makes `floor((latest start − earliest start) / cycle) + 1` trips a day, where the earliest start lets it
  arrive at the window's opening and the latest start still finishes unloading by its close (or the shift end).
  Example: 2-hour cycle, 7:00–17:00 window → 5 trips per truck.
- Trucks needed per day = loads ÷ trips per truck (rounded up). This replaces the dispatcher-entered "loads per day"
  of increment 1 with a computed figure, and lets one truck take several loads a day: each load gets its own start
  and end time (today all loads of a day share the order's window).
- If loads > available trucks × trips, the surplus is reported for that day; with flexible dates (decision below) it
  could move to another permitted day, with firm dates it is a conflict for the dispatcher.

### 9.4 Proposed data model (not created — needs decisions and approval)

All tables carry `company_id`, RLS limited to the company, writes by permission (`dispatch.edit` or
`settings.manage`), audit triggers; no secrets; additive migration with a rollback script.
- `sources` (quarries, plants, yards): name, address, optional latitude/longitude, opening hours, default loading
  minutes (+ source label), active. Also the foundation for alternative sources (requirement H).
- `route_times` (source × customer site): outbound and return minutes, each with source label, sample count when
  measured, updated by/at. Unique per company, source and site.
- `customer_sites.unload_minutes` (+ source label).
- `orders.source_id` (preferred source) and `orders.date_flexibility` (`firm` default, `flexible`), changes audited.
- `company_settings.shift_minutes` (nullable) until driver-hour rules are decided.
- No change to `order_loads` or `dispatch_assignments`: plans still become planned loads with start/end times.

### 9.5 Routing service (optional; nothing purchased or enabled)

A first version works without one: dispatchers enter minutes per source and site once, and measured times from
tickets refine them. A routing API (e.g. Google Routes / Distance Matrix, Mapbox Matrix, HERE with truck profiles,
or an OpenRouteService instance) would fill travel minutes automatically and could respect truck restrictions
(HERE). All are usage-priced beyond free tiers, need sites and sources geocoded, a server-side key in Vercel, and
the founder's approval of the cost before any account is created. Results would be stored with source `estimate`.

### 9.6 Staged plan

1. **Done (groundwork):** trip arithmetic and feasibility logic with tests.
2. Sources + route times + unload minutes (migration, rollback, settings screens) — needs decisions 1–2.
3. Load Build uses cycle times: computed trips per truck, staggered load times, per-day conflicts.
4. Measured times from tickets (read-only view, labelled "measured").
5. Firm vs flexible dates with authorized changes — decision 3.
6. Shift limits / driver-hour rules — decision 4; time off from the Employees area.
7. Routing API — decision 5 (cost approval).

### 9.7 Decisions needed (one at a time, first first)

1. Where do trip times come from at first: dispatcher-entered per quarry/site pair, or a routing service?
2. Is the loading source (quarry/plant/yard) chosen per order, per material, or per load?
3. Firm vs flexible: default firm? Who may change a firm date?
4. Driver limits: a company shift length, federal hours-of-service, or both?
5. Routing service budget, if any.

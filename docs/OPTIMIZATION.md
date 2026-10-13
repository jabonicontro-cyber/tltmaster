# Optimization core

Taviron's differentiator is whole-operation optimization: balancing service reliability, revenue, fleet
utilization, efficiency and workload, always under hard safety, legal, feasibility and company constraints. This
document describes what exists today (first slice, 2026-10-13), how it decides, and what comes next. Backlog rows:
master plan §12 B5 (this slice), B6–B10 (AI platform, Smart Dispatch Stage 2, profitability, customer intelligence,
routing).

## 1. What exists

| Piece | Where | What it does |
| --- | --- | --- |
| Smart Dispatch (Stage 1) | `src/lib/dispatch/smart.ts` | Per-load proposals, most urgent first, with reasons, alternatives and exclusions. |
| **Optimization core** | `src/lib/optimization/plan.ts` | A whole-day plan for every unassigned load across all trucks and drivers at once; configurable priorities; alternatives with trade-offs; statuses and missing-data notes. Pure and deterministic. |
| Data loader | `src/server/data/optimization.ts` | The Smart Dispatch input (RLS, caller's company) plus a revenue estimate per load. |
| Plan the day | `/dispatch/plan` (`src/app/(app)/dispatch/plan/`, `src/components/dispatch/optimization-planner.tsx`) | Choose a day and priorities, compare plans, review each assignment, approve a selection. |
| Approval | `approvePlanAssignments` (`src/app/(app)/dispatch/plan/actions.ts`) | Re-checks each selected assignment against current data, then `public.assign_load`; never replaces a confirmed assignment. |

No language model is involved: every quantity and constraint is calculated. A future AI layer (backlog B6) may
explain plans and help explore alternatives, but it will call this core rather than invent results.

## 2. How a plan is made

1. **Hard constraints first.** A truck–driver pair is considered for a load only if Smart Dispatch's `checkPair`
   accepts it: active and in service, no safety-critical work order or shop visit that day, no unresolved
   breakdown/inspection report, capacity at least the planned quantity, not a tractor without a trailer, driver's
   CDL and medical card valid and verified, no approved time off, no overlapping existing booking, not rejected by a
   dispatcher. Inside a plan, a truck or driver never gets two overlapping loads.
2. **Value of covering each load** (always positive) grows with the *service* weight (urgent, overdue, due that day)
   and the *revenue* weight (estimated revenue relative to the day's largest).
3. **Value of a pair** grows with the *utilization* weight (planned quantity ÷ recorded capacity), the *efficiency*
   weight (the truck already works that site that day; a site change costs), falls with the *balance* weight (the
   driver already has loads that day), and slightly prefers pairs with complete data.
4. **Search:** a greedy pass by load value, then improvement moves until none helps (move a load to another pair;
   free an assignment so a more valuable uncovered load fits, re-placing the freed one if possible). Bounded and
   deterministic (ties break by unit number and name).
5. **Alternatives:** the same search with each preset (Balanced, Service first, Revenue first, Efficiency first);
   identical plans are shown once. Trade-offs are listed against the plan for the chosen priorities.

## 3. Statuses and honesty rules

- **Verified feasible** only when every check passed *and* hours of service are verified. No ELD or driver-log data
  is connected, so today every assignment is **Needs review**, with the reasons listed (hours of service, unverified
  or missing capacity, open equipment report, pending time off, checks that could not run).
- **Blocked** loads: no pair passes the hard constraints, or every feasible pair is used by higher-value loads; the
  reason is shown. Smart Dispatch on the Dispatch board lists each truck's and driver's exclusion reasons.
- **Revenue** is an estimate: the order's material and hauling line rates in the load's unit × its planned quantity (aggregate per ton, freight per load; fixed one-off charges and surcharges are not spread over loads). No rate, no
  estimate — never a guessed price.
- **Margin is not evaluated:** no fuel, wage, maintenance or other cost data is recorded (master plan §9 Q17).
- **Travel distance and drive time are not calculated:** no truck locations or truck-routing provider. "Fewer
  empty trips" counts site changes and says so. A passenger-car router is never substituted.
- Confirmed assignments are never changed by a plan. Approval re-validates each assignment with fresh data, one at a
  time, and reports exactly which were assigned and why others were not.

## 3a. Blocked loads, unavailable resources and empty days (2026-10-13, after iPad testing)

- **Why a load is blocked:** for each load with no feasible truck, trailer and driver,
  `explainLoad` (`src/lib/optimization/availability.ts`) lists every truck, trailer and driver that cannot take it,
  each with the rule that stops it. The rules come from Smart Dispatch (`resourceExclusions` in
  `src/lib/dispatch/smart.ts`) and the optimizer's own trailer rules. When every resource is free on its own but no
  combination passes, the page says exactly that and points to Smart Dispatch for each pair; it never invents a
  reason.
- **Not available all day:** `unavailableResources` lists the resources that cannot take *any* open load that day,
  with the reasons common to every load (out of service, safety-critical work, expired qualifications, approved time
  off covering the day). Resources busy for only part of the day appear under the loads they block.
- **Changing the day:** a **Show plan** button next to the day keeps the current preset or custom priorities.
- **Loading:** `dispatch/plan/loading.tsx` says what is being checked while the plan is computed.
- **Empty days:** a day with nothing to plan is no longer a dead end. The page lists the days in the next two weeks
  that have loads waiting for a truck and driver (`getUpcomingOpenLoadDays`), and points to the Dispatch board and
  "Needs scheduling".
- **Revenue for freight:** the estimate now includes hauling lines in the load's unit (for example "per load"), not
  only material lines. Before this, Prairie Lantern's per-load linehaul showed $0.
- **Vehicle documents:** when the latest registration, insurance, inspection or permit on record for the truck or
  trailer expired before the day, the proposal carries a review note ("… expired … — confirm it was renewed"). No
  assignment rule uses vehicle documents today, so this never blocks. If the documents cannot be read, a data note
  says so.
- **Not modelled (stated, not hidden):**
  - Loads have one site and a time window; there is no separate pickup stop, so pickup-before-delivery order is only
    the load's own window.
  - Hours of service are not verified (no ELD data). Every proposal stays **Needs review**.
- **Demo data:** Refresh gives tomorrow loads; `planningDay` (`src/server/demo/samples.ts`) tops tomorrow up to four
  open loads. In Prairie Lantern, the open trailers, booked trailers and out-of-service truck 207 exercise the blocked
  and unavailable views. A demo refreshed before a given day shows the empty state for later days until it is
  refreshed again.

## 4. Demo coverage

Demo modes with dispatch access (Owner, Dispatcher, Dispatcher who also drives, Office) open **Plan the day**;
Driver and Mechanic have no dispatch access. Demo companies need unassigned loads on upcoming days to show a plan:
the seeds and **Refresh demo data** leave open loads (see DEMO_TENANTS §5); approving in a demo assigns fictional
loads only.

## 5. Next steps (dependency order)

1. Persist company priority defaults (settings; needs a migration — owner applies).
2. Multi-day horizon and trailer pairing for tractors (Prairie Lantern-style fleets).
3. Disruption repair: when a truck goes out of service or a driver calls off, propose the smallest set of changes
   (Smart Dispatch Stage 2, backlog B7) — never applied without approval.
4. Recorded decisions (approved vs edited vs rejected) as learning evidence; outcomes from delivered tickets.
5. Cost inputs and load profitability (B8) once cost data exists; routing and ELD adapters (B10) once providers are
   approved.

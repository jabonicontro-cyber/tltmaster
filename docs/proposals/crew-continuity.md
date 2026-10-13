# Proposal: keep a driver with one truck through the day (master plan §9 Q20)

**Status:** proposal; not built. Driver–truck pairing is an open decision (§9 Q20), so Plan the day does not prefer
it today.

## What happens now

In the presenter demo (2026-10-13), Plan the day's Balanced plan put all four loads of one order on **truck 101 with
four different drivers** (Avery Lindqvist, Daniel Mitchell, Marco Delgado, Nia Okafor), one per load. Every hard rule
passes and nothing is wrong legally, but a dispatcher would not normally swap the driver between consecutive loads.

Why the search does this: the *efficiency* priority rewards a truck staying on the same site, and the *balance*
priority rewards spreading loads across drivers. Nothing rewards a driver staying on the same truck, and the
planner does not know each driver's primary truck (`drivers.primary_truck_id`).

## Proposed change (if approved)

- A sixth priority, **"Keep crews together"** (0–5), scored like the others:
  - a bonus when a load goes to the same truck–driver pair as that driver's earlier load that day;
  - a smaller bonus when the truck is the driver's primary truck.
- **Default weight 0 in every preset**, so today's plans stay identical until a dispatcher or the owner turns it up.
  The golden comparison used for the planner speed-up can confirm this.
- Scoring only: never a block, and no business rule is invented. The explanation names it ("keeps Avery on truck
  101").
- Tests: unit tests for the bonus and for default plans being unchanged; the demo planning day would show the
  difference when the slider is raised.

## Decision needed

1. Should Plan the day offer this preference at all?
2. If yes, should any preset use it by default (for example Efficiency first)?

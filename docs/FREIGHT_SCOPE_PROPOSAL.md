# Freight scope after MK2: load boards and factoring (proposal)

**Status: proposal for the owner, not decided.** Master plan §9 Q28 (owner 2026-11-05: limited freight experience, has
used Princeton TMX, a shipper-side system; Claude proposes, the owner reviews). Written 2026-11-14 from general
knowledge of how small US carriers work and from this repository. No provider was contacted and no website was read
(this environment blocks most outside sites), so nothing here states a provider's prices, terms or API access.

## What freight already has (built, on Production)

- Loads with several pickups and deliveries, appointment windows and references; Arrived / Left at each stop (MK2).
- Per-mile and flat rates; extra charges (lumper, layover, truck ordered not used) added to the order before billing;
  detention from recorded waits (DT1).
- Documents on the order or a stop: rate confirmation, bills of lading, proof of delivery (MK2, 2026-11-09).
- Brokers as customers with an MC number; the broker's load number on invoices (MK2).
- Invoices from Taviron, payments recorded against tickets or invoices (TP1), QuickBooks hand-off (off until LR6).
- Still to do in MK2: the driver adding proof of delivery from the phone at a stop.

## Factoring: what carriers need, and the proposal

Many small freight carriers sell their invoices to a factoring company to be paid in days instead of waiting for the
broker. In general the factor needs, for each load: the invoice, the rate confirmation and the signed bill of lading
or proof of delivery; the broker is told (a notice of assignment) to pay the factor instead of the carrier, so the
invoice must show the factor's "remit to" address. Each factor has its own portal or upload rules.

**Proposed (small, no partner needed, after the driver's proof of delivery):**
1. **Factoring packet:** on a freight invoice, one download with the invoice PDF plus the order's rate confirmation and
   proof of delivery files, named by load number, ready to upload to any factor's portal or email.
2. **Remit to a factor, per customer:** a customer (usually a broker) can be marked "paid through factoring" with the
   factor's name and remit-to address, printed on that customer's invoices. A person sets it; nothing is sent.
3. **Factored invoices in the money views:** an invoice can be marked "submitted to factor"; payments from the factor
   are recorded with the existing payments (TP1), so Money owed and aging stay true. Fees the factor keeps are entered
   as the person sees them on the factor's statement; Taviron never calculates a factoring fee.
4. **A schedule of invoices** (CSV of the invoices submitted together: number, broker, load number, amount), since many
   factors ask for one with each batch.

**Not proposed:** direct connections to a named factoring company (each one is a separate agreement and integration),
credit checks on brokers, or moving money. These need a customer who asks for a specific factor and the owner's
approval of that partner.

## Load boards: proposal

Load boards (DAT and Truckstop are the best known in the US) are where brokers post loads and carriers find them.
Connecting to one usually needs that board's own subscription and a separate API or partner agreement, and the
carrier still books the load with the broker by phone or in the board's own app.

**Proposed: no load board connection before launch.** Instead, after launch:
1. **Quick freight order entry** from what the dispatcher has in front of them (broker, MC number, pickup and
   delivery stops with windows, rate, load number), with the rate confirmation attached in the same step. This covers
   loads from any board, broker email or phone call, with no partner.
2. **Revisit a board connection** when a paying freight customer asks for one and names the board they use; then
   check that board's current terms, cost and API access before promising anything.

## Recommendation

1. Finish MK2 (driver proof of delivery from the phone) first; factoring depends on it.
2. Then build factoring items 1 to 4 above, in that order, as one small feature (likely one migration for the customer
   setting and invoice mark; review tier; demo samples in the freight demo, Cobalt Plains Freight).
3. Load boards: after launch, only on a customer's request.

Aggregate companies see none of this (freight wording and areas follow the company's "What you haul", MK1).

## Decisions for the owner (asked one at a time, each with this recommendation)

1. Factoring support as above, after the driver's proof of delivery: **recommended yes, for January or soon after.**
2. Load board connections: **recommended not before launch; revisit when a freight customer asks.**

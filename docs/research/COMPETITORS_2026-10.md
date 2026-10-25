# Competitor research: aggregate and dump-truck hauling software (2026-10-25)

Requested by the owner before website work ("competitor research first"). Method: web searches only; the research
environment could not open vendor pages directly, so findings come from search summaries of vendor pages, review
directories (Capterra, Slashdot, SoftwareFinder) and vendor-written comparisons. **Most figures are vendor claims or
directory listings, often conflicting; verify before quoting any of them.** Nothing here may be put on the website as a
claim about a competitor without checking the source page first.

## Who shows up

| Vendor | Positioning (as described) | Pricing visibility | Notable |
| --- | --- | --- | --- |
| Tread | Dump truck dispatch + e-ticketing for bulk haulers; company trucks, owner-operators and subcontractors on one board | Published: starter tier $1,250/month, annual, by load volume (vendor page) | Job requests by text (reply YES/NO, no app needed); AI reads scale tickets ("95%+" claimed), duplicate-ticket flags; QuickBooks Online/Desktop sync; GPS from app or telematics (Motive, Samsara); "live in as little as a day", self-onboarding; publishes usage metrics (e.g. median 26 min to build tomorrow's schedule) and a customer quote. **Says it does not do maintenance/DVIRs and does not replace an ELD.** Publishes "vs" pages and a "best software" roundup. |
| TruckIT | Construction hauling; scale-house e-ticketing (AirTicket), computer-vision ticket reading (TicPic/ATP), Smart Dispatch | Not published / conflicting ($250/month minimum or per-truck figures in directories) | Integrations listed: QuickBooks, NetSuite, Dynamics 365, Samsara, Verizon Connect; API. |
| TRUX | Marketplace connecting producers/contractors with third-party dump trucks; driver booking app | Quote only | Large driver/owner-operator network (vendor claims 60,000+ users). |
| Toro TMS | Bulk/aggregate TMS: load creation, drag-and-drop scheduling, driver portal tickets, driver pay rules (hour/load/ton/mile), QuickBooks sync | Quote; month-to-month, no annual contract, no onboarding fee (vendor blog) | Commercial terms are the differentiator; maintenance described as limited. |
| Dump Truck Dispatcher | All-in-one: quotes, orders, dispatch, maintenance, digital tickets, invoicing, driver pay, subcontractors, DOT compliance | **Published per truck**: about $20–35/truck/month, 10-truck minimum; Basic flat plan for small fleets (figures vary by source) | Closest to Taviron's breadth; reviews mention no built-in GPS map. |
| Others named in roundups | HCSS Dispatch, Command Alkon, HaulHub (DOT e-ticketing), Dispatch360, FleetRabbit (OCR tickets), LoadOps, Axon, TruckLogics | Mostly quote-based | Enterprise/ERP-leaning or general trucking. |

## Patterns across the market

1. **Ticket capture is the battleground:** photo/OCR/AI reading of scale tickets, duplicate detection, e-tickets at the
   scale house.
2. **Owner-operators and subcontractors on the same board,** and reaching drivers **by text without an app.**
3. **Accounting sync (QuickBooks) is table stakes;** telematics/GPS integrations (Samsara, Motive) are common.
4. **Fast start:** "live in a day", self-onboarding, month-to-month terms.
5. **Proof:** usage metrics, customer quotes, "vs" comparison pages and self-published "best of" roundups (SEO).
6. **Pricing:** split. Tread and Dump Truck Dispatcher publish numbers; most others say "book a demo".

## Where Taviron stands (from this repository, 2026-10-25)

Strong, and rarely claimed together by dispatch-first competitors:
- One system across quotes → orders → dispatch → tickets → billing readiness → driver pay → **maintenance** (crews,
  timers, shop capacity, triage, clearance; Tread explicitly does not do maintenance/DVIRs), fleet records, people,
  **shift schedules checked at dispatch**, time off, communications, customer portal, multiple bases.
- Plan the day / Smart Dispatch with explanations and human approval; safety-first rules enforced in the database.
- Driver and mechanic phone app (home-screen install).

Gaps compared with the market (product, not website):
- **No accounting sync** (exports are CSV and explicitly not QuickBooks formats).
- **No automatic ticket reading** (ticket photos/scans are stored; a person enters the values).
- **No owner-operator / subcontracted hauler model** and no dispatch by text message.
- **No live GPS/telematics** (needs a provider; already listed as blocked).
- No scale-house e-ticketing.

## What would set the website apart (evidence-based)

1. **Lead with breadth that dispatch-only tools disclaim:** "dispatch, tickets, billing *and* the shop": maintenance,
   shift schedules and payroll in one place. True today and directly contrasts with tools that say they do not do
   maintenance.
2. **Publish prices** (or "from $X"): only some competitors do; it builds trust with small fleets. Owner decision.
3. **Self-serve demo** with role views (owner, dispatcher, driver, mechanic, customer): competitors are mostly "book a
   demo"; Tread offers self-onboarding.
4. **"Live fast" promise backed by the onboarding kit and imports**, stated honestly (a timeline we can keep).
5. **Honest comparison content:** "Taviron vs spreadsheets and whiteboards" and "all-in-one vs dispatch-only" pages,
   without unverified claims about named competitors.
6. **Proof from real use** once the first customer runs on it: measured medians (time to plan tomorrow, days from
   delivery to billing-ready), the way Tread publishes usage metrics; never invented.

## Product gaps worth prioritising (to compete, not just to market)

In order of how often they appear as table stakes: QuickBooks sync (needs owner authorization: accounting exports),
ticket photo reading with review (AI, through the existing AI rules and evaluations), owner-operator/subcontractor
haulers with text-message job offers (needs an SMS provider and approval), telematics GPS (provider choice).

## Sources

- [Aggregate Dispatch Software: 5 Top Options for Bulk Haulers (Toro)](https://www.torotms.com/blog/aggregate-dispatch-software)
- [Best Dump Truck Dispatch Software (2026): 6 Tools Compared (Tread)](https://tread.ai/blog/best-dump-truck-dispatch-software/)
- [Tread pricing](https://tread.ai/pricing/) · [Tread vs TRUX](https://tread.ai/vs/trux/) · [Tread dump truck dispatch](https://tread.ai/dump-truck-dispatch-software/) · [Tread live tracking](https://tread.ai/product/live-tracking/)
- [TruckIT on Capterra](https://www.capterra.com/p/195776/TruckIT/) · [TruckIT on SoftwareFinder](https://softwarefinder.com/construction/truckit) · [WorkTruck: fleet converts to digital ticketing with TruckIT](https://www.worktruckonline.com/news/dump-truck-fleet-converts-to-digital-ticketing-with-truckit)
- [TRUX](https://www.truxnow.com/) · [TRUX driver app](https://www.truxnow.com/products-drive) · [TRUX on Capterra](https://www.capterra.com/p/216094/TRUX/)
- [Toro: Trux review, pricing and alternatives](https://www.torotms.com/blog/trux-now-review-pricing-alternatives) · [Toro TMS on SoftwareFinder](https://softwarefinder.com/fleet-management-software/toro-tms)
- [Dump Truck Dispatcher pricing](https://dumptruckdispatcher.com/pricing/) · [Dump Truck Dispatcher](https://dumptruckdispatcher.com/) · [Dump Truck Dispatcher on Slashdot](https://slashdot.org/software/p/Dump-Truck-Dispatcher/)
- [Dispatch360 aggregate](https://www.dispatch360.com/dispatch-software/aggregate) · [FleetRabbit](https://fleetrabbit.com/blogs/post/dump-truck-fleet-management-aggregates-hauling) · [Skeyewatch e-ticketing](https://www.skeyewatch.com/paperless-eticketing/)
- [Bulk hauling software 2026 comparison](https://bulkhaulsoftware.com/best-bulk-hauling-software-2026) · [Connecteam trucking dispatch roundup](https://connecteam.com/trucking-dispatch-software/)

# Workflow modules (MOD1)

Owner decisions 2026-11-16 (master plan §12, row MOD1), asked question by question:

1. Each main workflow can be switched on or off per company and the steps adapt. Setup offers starting points
   ("Tickets to billing", "Quotes only", "Full operations") the owner then adjusts. This replaces SF1's menu-only
   hiding. Safety areas (Safety, Driver Reports, Communications) can never be switched off.
2. With Dispatch off, a delivery ticket is entered against the customer and their job (an order that holds the
   material and agreed prices, creatable in one step from the ticket screen), with ticket number, date, quantity and
   a photo. Truck and driver may be picked but are not required. Billing prices come from the job, as today.
3. Quotes only: an accepted quote is marked won (who, when), counts in the pipeline and reports, and creates no order.
   If Orders is switched on later, accepted quotes become orders with one click (the existing conversion).
4. Plans and prices stay as they are. A module the plan does not include stays unavailable (today: the customer
   portal and hired trucks entitlements).
5. The company owner (`settings.manage`) changes modules any time in Settings; a Taviron Admin picks the starting
   preset when setting a company up. Switching a module off hides it and its steps and never deletes records;
   switching it back on shows everything again. Every change is recorded.

## 1. The modules

Stored per company in `company_settings.modules_off` (the modules switched **off**; empty means everything on, so
every existing company is unchanged). The keys are fixed by a check constraint; the list lives in
`src/lib/modules.ts`.

| Module (key) | What it holds (pages) | Needs |
| --- | --- | --- |
| Quotes (`quotes`) | `/quotes` | – |
| Orders and jobs (`orders`) | `/orders`, `/order-documents` | – |
| Dispatch (`dispatch`) | `/dispatch` (board, plan the day, truck days), `/route-planner`, `/hired-trucks` | Orders |
| Delivery tickets (`tickets`) | `/tickets` | Orders (a ticket belongs to a job) |
| Billing (`billing`) | `/billing` (readiness, handoffs, invoices, payments), `/accountant` | Delivery tickets |
| Order to Cash (`order_to_cash`) | `/order-to-cash` | Orders and Billing |
| Payroll (`payroll`) | `/payroll` | Delivery tickets (pay comes from tickets with a driver) |
| Maintenance (`maintenance`) | `/maintenance` | – |
| Customer Portal (`customer_portal`) | `/customer-portal` | – (and the plan's portal entitlement) |
| Support (`support`) | `/support` | – |
| Schedule (`schedule`) | `/schedule` | – |
| Time Off (`time_off`) | `/time-off` | – |
| Reports (`reports`) | `/reports` | – |

Always on (not modules): My Day, Morning briefing, Command Center, Communications, Customers, Materials & Pricing,
Fleet, Driver Reports, Safety, People, Settings, Search, Help. Safety, Driver Reports and Communications can never be
switched off (owner decisions SF1 and MOD1); fleet, people and customers are records every module uses.

Dependencies are enforced in both places: Settings switches a dependent module off with the one it needs (and says
so), and the database refuses a combination that breaks one (`private.modules_check`).

**SF1 migrated, not duplicated.** SF1's nine hideable areas are nine of these modules, with the same paths. The
migration copies each company's `hidden_areas` into `modules_off`; the Starter default (owner decision 2026-11-14:
a new Starter company starts with Quotes, Support, Customer Portal, Order to Cash, Payroll, Schedule, Time Off and
Reports off) now writes `modules_off`. Settings → Company → "Areas in the menu" becomes **"What you use"**. The old
`hidden_areas` column is kept (never dropped) and a save of it by the previous app version is mirrored into
`modules_off`, so the code before and after the migration both work.

## 2. Presets (starting points)

A preset only fills in `modules_off`; the owner adjusts any module afterwards.

| Preset | On | Off |
| --- | --- | --- |
| Full operations | everything | nothing |
| Tickets to billing | Orders and jobs, Delivery tickets, Billing, Maintenance, Reports | Quotes, Dispatch, Order to Cash, Payroll, Customer Portal, Support, Schedule, Time Off |
| Quotes only | Quotes, Maintenance, Reports | Orders and jobs, Dispatch, Delivery tickets, Billing, Order to Cash, Payroll, Customer Portal, Support, Schedule, Time Off |

Maintenance stays on in every preset because the owner kept it on for Starter companies as safety core (2026-11-14);
see Open questions.

## 3. Who changes modules, and the record

- **Company owner** (anyone with `settings.manage`): Settings → Company → What you use, any time, through
  `public.set_company_modules(text[])` (permission checked in the database, own company only). Demo role previews
  narrow permissions, so a preview without `settings.manage` cannot change them. A Taviron support visit can change
  them like any other company setting (it changes no person, role, permission or sign-in).
- **Taviron Admin** (platform level Admin, not Support): console → company page → "Starting setup", through
  `public.platform_set_company_modules(uuid, text)` with a preset name, only while the company has not gone live, or
  for a demo company. After go-live only the owner decides.
- **Record:** every change writes the company audit log ("What you use: Dispatch switched off, …", with who and the
  before/after lists) and, for the Admin, platform activity.

## 4. What switching off does (and does not do)

Switching a module off **hides** it: its menu entry, its pages (they show "Switched off" with, for owners, a link to
Settings), its Command Center items, its getting-started steps, its search results, its help articles and its
notifications and links on other pages. It never deletes, cancels or changes a record, a permission or a rule.
Switching it back on shows everything again, as it was. Plan entitlements still apply on top: a module that is on but
not in the plan (customer portal without the entitlement) shows its usual "not included" state.

One function decides, for every place: `moduleOfHref(href)` maps a link to its module and `hrefShown(href, off)`
answers whether it is shown (`src/lib/modules.ts`). The menu, Command Center, getting started, search, help and
notification lists filter through it, and each module's pages are wrapped in a `ModuleGate` layout, so a switched-off
area never leaves a working link elsewhere.

**Steps adapt:** with Dispatch off the ticket screen starts from the job instead of a dispatched load, orders show
"Enter a ticket" instead of "Dispatch the loads", and billing's "missing tickets" step points to the ticket entry;
with Orders off an accepted quote shows "Won" instead of "Convert to order".

## 5. Tickets without Dispatch

Today every ticket needs an order, a load, an assignment, a truck and a driver (`20261015000100`). With Dispatch off:

- **Entry** (`/tickets/new` without a load): customer → job (or **New job** in one step) → material line → paper
  ticket number, delivery date (time optional), quantity and unit → photo of the paper ticket; truck, trailer and
  driver may be picked. `public.submit_ticket_without_dispatch(jsonb)` (`tickets.edit`) checks the company has
  Dispatch off, Orders and Tickets on, and the job is in a ticketable state; it records the delivery as its own
  load on the job (`order_loads.from_ticket = true`, no planned quantity, no assignment) and the ticket on it
  (`delivery_tickets.without_dispatch = true`, assignment empty, truck and driver optional).
- **Why a load is still recorded:** billing readiness, the order's progress, the customer portal and reports are all
  load-based. A ticket's own load keeps every one of them correct without touching them. Such a load can never be
  assigned (database trigger) and never appears on the dispatch board, Plan the day or the "needs a truck" checks.
  Voiding its ticket cancels it, so billing never waits for a ticket that will not come.
- **New job in one step:** `public.create_ticket_job(jsonb)` creates the order through the existing order functions
  (`save_order_draft`: prices from the customer's price list, typed prices go through the price check;
  `update_order_schedule`; `set_order_status` to In progress) in one transaction, so every order rule and permission
  (`orders.edit`, `orders.schedule`) applies unchanged.
- **Review, billing, invoice:** unchanged. Review accepts or flags the ticket; billing readiness counts it; the job is
  completed (or fulfilled) and handed off; the invoice draft prices the accepted quantities with the job's prices.
- **Corrections** keep the ticket's load and recheck the same way; the load follows the corrected date.
- **Payroll:** only tickets with a driver are payable; a ticket without one is simply not in a pay period. Driver
  scorecards and truck hours count only what has a driver or truck. Hauler settlements stay assignment-based.
- **Customer portal:** the ticket shows as any ticket; truck and driver show as not recorded.
- **Companies that dispatch:** nothing changes. A ticket still needs its load's active assignment, truck and driver
  (`delivery_tickets_dispatch_refs` check: only a ticket marked `without_dispatch` may leave them empty, and only
  `submit_ticket_without_dispatch` writes one, only while Dispatch is off).
- **Dispatch switched on later:** tickets entered without dispatch stay as they are, with their own loads; new tickets
  go through dispatch again.

## 6. Quotes without Orders

- Today accepting a quote also creates its order automatically (trigger from `20261027000100`). With Orders switched
  off it no longer does: the quote shows **Won** with who and when (`quotes.accepted_by`, new, filled from the status
  history for earlier quotes) and counts as won in the pipeline, the Command Center and reports.
- The database refuses `convert_quote_to_order` while Orders is off ("Orders are switched off …"), so no path creates
  an order. When Orders is switched on, each won quote has its existing one-click **Convert to order**. Companies
  with Orders on keep today's automatic order on acceptance.

## 7. Enforced in the database vs the app

| Rule | Where |
| --- | --- |
| Only known modules, dependencies kept, own company, `settings.manage` | Database (`set_company_modules`, check constraint, `private.modules_check` trigger) |
| Admin preset only before go-live (or for demos); Admin level only | Database (`platform_set_company_modules`) |
| Every change audited | Database (audit log, platform activity) |
| Ticket without a load assignment only while Dispatch is off; never on a dispatched load; ticket loads never assigned | Database |
| No order from a quote while Orders is off | Database (`convert_quote_to_order`, the acceptance trigger) |
| Hiding menus, pages, steps, lists and links | App (`src/lib/modules.ts`, `ModuleGate`) |
| Creating orders, dispatching loads while switched off | App (pages and actions hidden and refused); the database keeps permissions as they are, because switching off changes no permission |

## 8. Demos

Presenter and prospect demos stay **Full operations** (nothing off) and Refresh demo data never changes modules.
To show a preset, the demo's owner uses Settings → What you use in the demo (the same page as every company), or a
Taviron Admin picks a preset for the demo in the console; "Full operations" puts it back. Refresh keeps adding the
full sample data while modules are off (it is hidden, never deleted), so switching back shows it all. No demo-only
code; demo samples need nothing new because demos dispatch (tickets without dispatch exist only while Dispatch is off).

## 9. Open questions (one at a time, each with a recommendation)

1. Should Maintenance be on in "Tickets to billing" and "Quotes only"? Recommendation: yes, on, as the Starter decision
   kept it as safety core (built that way).
2. Should a new job made from the ticket screen ask for the job's expected quantity, or take the first ticket's?
   Recommendation: ask, pre-filled with the ticket's quantity (built that way).
3. When a ticket is entered without a delivery time, should the time stay empty? Recommendation: yes; the ticket shows
   the date only ("time not entered"), and the database keeps the date (built that way, stored at midday local time
   or now when it is today).
4. Should "Tickets to billing" turn Payroll on when a company records drivers on tickets? Recommendation: no, keep it
   off; the owner switches it on in Settings when wanted.

import type { Faq } from "./faq";
import { ANNUAL_DISCOUNT_PERCENT, EXTRA_TRAINING_CENTS, usd } from "./pricing";

// Pricing questions, shown on /pricing and /faq (written once here).
export const PRICING_FAQ: Faq[] = [
  {
    q: "Which tier fits my company?",
    a: "The lowest tier that covers both your number of hauling trucks and your number of dispatch bases. Trucks are the active, company-managed hauling trucks you track in Taviron, including ones temporarily in the shop, in seasonal storage or in reserve. Pickups and maintenance vehicles don't count. A dispatch base is a location you dispatch from; several yards run as one base count once.",
  },
  {
    q: "When does billing start?",
    a: "The one-time onboarding fee is paid when you sign up. The monthly subscription starts at go-live (the date you and the Taviron team agree on), not during setup, configuration, testing or training.",
  },
  {
    q: "How does the annual commitment work?",
    a: `It is a 12-month commitment, paid monthly, at ${ANNUAL_DISCOUNT_PERCENT}% off the standard monthly price. It renews for another 12 months unless you turn renewal off, and you are reminded before it renews.`,
  },
  {
    q: "What happens if we grow past our tier?",
    a: "Going over a tier's truck or dispatch-base limit starts a 30-day grace period, and we email you. If you are still over it after 30 days, your subscription moves to the lowest tier that fits from the next billing date. No plan change happens without notice.",
  },
  {
    q: "Is there a free trial?",
    a: "There is a free demo: a walkthrough of the live demo company with fictional data, led by the Taviron team. There is no free trial.",
  },
  {
    q: "Can I pay on this website?",
    a: "No. Nothing is charged through this website. Your tier, prices and terms are set out in a written service agreement before anything is billed.",
  },
];

// Switching from spreadsheets (shown on /pricing and /faq). Only what is already true in the product and on the pricing
// page, plus the go-live, cancellation and data-export terms the owner set on 2026-11-09.
export const SWITCHING_FAQ: Faq[] = [
  {
    q: "How long does it take to go live?",
    a: "Plan for about 2 to 4 weeks from sign-up to go-live: importing your records, setup, training and a test period. You pick the go-live date, and the monthly subscription starts then. Larger fleets with several dispatch bases may take longer.",
  },
  {
    q: "Can we cancel if it does not work out?",
    a: "Yes. Standard plans are month to month: cancel any time with 30 days' notice and no cancellation fee. The onboarding fee is not refunded. An annual commitment runs its 12 months.",
  },
  {
    q: "Can we take our data with us if we leave?",
    a: "Yes. When you leave, we provide your records (customers, orders, loads, tickets with their photos, invoices, people and trucks) as spreadsheet files within 30 days of your request, and then delete your company's data.",
  },
  {
    q: "Can we bring our existing spreadsheets?",
    a: "Yes. Onboarding includes importing your existing records: customers, materials, trucks and drivers come in from CSV files (save Excel sheets as CSV first). Every row is checked and shown to you before anything is created, possible duplicates are flagged, and an import can be undone. Orders, tickets and history are not imported.",
  },
  {
    q: "How does the team learn it?",
    a: `Onboarding includes one live training session. More sessions are ${usd(EXTRA_TRAINING_CENTS)} each, up to 60 minutes. The demo walks through the product from each role's point of view, so you can see what your dispatchers, office and drivers will use.`,
  },
  {
    q: "What if a driver has no signal at a job site?",
    a: "The driver app keeps today's loads on the phone. Tickets, inspections and arrival taps made without signal are saved on the phone and sent when signal returns, with the time they really happened. Photos need signal.",
  },
  {
    q: "Does it work with QuickBooks?",
    a: "Not yet. QuickBooks Online sync is coming soon and is not available today. Each company chooses who bills: Taviron issues the invoice from the verified deliveries once someone approves it, or ready orders are handed off in batches to your own accounting.",
  },
  {
    q: "What support do we get?",
    a: "Email support, Monday to Friday, 9 a.m. to 5 p.m. Central, excluding U.S. federal holidays, with a first response targeted within one business day.",
  },
];

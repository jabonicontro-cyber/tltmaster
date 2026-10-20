import type { Faq } from "./faq";
import { ANNUAL_DISCOUNT_PERCENT } from "./pricing";

// Pricing questions, shown on /pricing and /faq (written once here).
export const PRICING_FAQ: Faq[] = [
  {
    q: "Which tier fits my company?",
    a: "The lowest tier that covers both your number of hauling trucks and your number of dispatch bases. Trucks are the active, company-managed hauling trucks you track in Taviron — including ones temporarily in the shop, in seasonal storage or in reserve. Pickups and maintenance vehicles don't count. A dispatch base is a location you dispatch from; several yards run as one base count once.",
  },
  {
    q: "When does billing start?",
    a: "The one-time onboarding fee is paid when you sign up. The monthly subscription starts at go-live — the date you and the Taviron team agree on — not during setup, configuration, testing or training.",
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

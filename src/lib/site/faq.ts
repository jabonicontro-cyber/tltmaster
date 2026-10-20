// Frequently asked questions for the public website (/faq). Answers describe the product as it is today (feature
// catalog, docs/MARKETING.md); pricing answers live with the pricing page (PRICING_FAQ) so they are written once.

export interface Faq {
  q: string;
  a: string;
}

export const PRODUCT_FAQ: Faq[] = [
  {
    q: "What is Taviron?",
    a: "An operations platform for trucking and aggregate hauling companies: customers and quotes, orders, dispatch, the driver's phone, delivery tickets, maintenance, billing readiness and reports, in one set of connected records.",
  },
  {
    q: "Who is it for?",
    a: "Companies that haul for their own customers — from an owner who also dispatches a handful of trucks to operations with several dispatchers, a shop and an office team.",
  },
  {
    q: "Does Taviron assign loads automatically?",
    a: "No. Smart Dispatch and Plan the day propose trucks and drivers that pass your rules and explain what they cannot cover; a dispatcher approves every assignment, and approval re-checks it against the latest data.",
  },
  {
    q: "Does it track hours of service or GPS location?",
    a: "Not yet. There is no ELD or GPS connection today, so every proposal reminds the dispatcher to confirm each driver's hours of service.",
  },
  {
    q: "Does Taviron send invoices or take payments?",
    a: "No. It tells you which orders are fully delivered and verified, prepares an invoice draft for review and hands ready orders to your accounting in batches. Invoices are issued in your accounting system.",
  },
  {
    q: "Does Taviron use AI?",
    a: "AI assistance is built but not switched on yet. When it is, it reads only what the person may see, explains and drafts, and never assigns, sends, bills or changes records on its own.",
  },
  {
    q: "Can drivers use it on their phones?",
    a: "Yes. Drivers see their day, job instructions and assignments, submit delivery tickets with photos and report delays or equipment problems from the phone. The app can be installed to the home screen.",
  },
  {
    q: "What does the demo show?",
    a: "The real product with a demo company full of fictional customers, orders, trucks and drivers, walked through by the Taviron team from each role's point of view. Nothing in the demo is sent to anyone.",
  },
  {
    q: "How is our data protected?",
    a: "Each company's records are separated in the database by row-level security, permissions are checked on the server and in the database, and key changes keep who made them. The Trust & Security page lists what is in place and what is not yet.",
  },
  {
    q: "How do we get help?",
    a: "Signed-in users have a Help Center with step-by-step articles for each page. For anything else, use the contact form; support terms are set out in your service agreement.",
  },
];

import { HELP_ARTICLES } from "@/lib/help/articles";
import type { HelpArticle } from "@/lib/help/types";

// Public guides (master plan B88): a short, chosen list of the in-app Help Center articles (src/lib/help/articles.ts),
// so there is one text per workflow and it is reviewed with the product. Only articles for published catalog features
// are listed (tests/unit/site-pages.test.ts); the rest of the Help Center stays inside the app, as does anything about
// settings, security or administration.

export const PUBLIC_GUIDES: Array<{ article: string; feature: string }> = [
  { article: "quotes", feature: "orders" },
  { article: "orders", feature: "orders" },
  { article: "plan-the-day", feature: "plan-the-day" },
  { article: "smart-dispatch", feature: "smart-dispatch" },
  { article: "driver-reports", feature: "driver-portal" },
  { article: "delivery-tickets", feature: "delivery-tickets" },
  { article: "ticket-review", feature: "delivery-tickets" },
  { article: "billing", feature: "billing" },
  { article: "maintenance-work-orders", feature: "maintenance" },
  { article: "time-off", feature: "people" },
];

export function publicGuides(): HelpArticle[] {
  return PUBLIC_GUIDES.map((g) => HELP_ARTICLES.find((a) => a.id === g.article)).filter((a): a is HelpArticle => a !== undefined);
}

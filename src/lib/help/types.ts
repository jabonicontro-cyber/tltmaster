import type { Permission } from "@/lib/permissions";

/**
 * Help Center articles (master plan B65). Articles live in the repository so every change is reviewed like code and
 * versioned by git; `reviewed` is the date someone last checked the article against the running product. An article
 * describes only what exists: a feature that needs a database update, a provider or a setting says so.
 */
export type HelpCategory =
  | "getting-started"
  | "customers"
  | "quotes-orders"
  | "dispatch"
  | "fleet"
  | "maintenance"
  | "tickets-billing"
  | "people"
  | "communications"
  | "settings"
  | "reports";

export interface HelpTask {
  /** "Create a customer" — the task as the user would phrase it. */
  title: string;
  steps: string[];
}

export interface HelpArticle {
  id: string;
  title: string;
  /** One sentence: what the page or workflow is for. */
  summary: string;
  category: HelpCategory;
  /** App routes this article explains (exact path or prefix ending in "/*"); used for contextual help. */
  routes: string[];
  /** The person sees the article only with one of these permissions (empty = every signed-in company user). */
  permissions: Permission[];
  /** Who typically uses it, in plain words. */
  audience: string;
  /** What appears on the page. */
  whatYouSee: string[];
  tasks: HelpTask[];
  /** Permissions or setup needed, in plain words. */
  prerequisites: string[];
  /** "Problem — what to do". */
  troubleshooting: Array<{ problem: string; fix: string }>;
  /** Where to go next in the workflow (article ids). */
  next: string[];
  related: string[];
  /** Last checked against the product (ISO date). */
  reviewed: string;
  /** Limitations stated honestly (feature not installed yet, provider needed). */
  limitations?: string[];
}

export const HELP_CATEGORIES: Record<HelpCategory, string> = {
  "getting-started": "Getting Started",
  customers: "Customers and CRM",
  "quotes-orders": "Quotes and Orders",
  dispatch: "Dispatch",
  fleet: "Fleet and Drivers",
  maintenance: "Maintenance",
  "tickets-billing": "Delivery Tickets and Billing",
  people: "People and Time Off",
  communications: "Communications",
  settings: "Settings and Administration",
  reports: "Reports",
};

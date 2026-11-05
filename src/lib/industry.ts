// Industry profile (owner 2026-11-05, master plan MK1): aggregate hauling stays Taviron's focus, and general freight
// carriers should feel at home too. A company chooses what it hauls in Settings; the choice changes the words people
// see (and, later, defaults), never the code path or the rules: one application for every company.

export const INDUSTRIES = ["aggregate", "freight", "both"] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const INDUSTRY_LABELS: Record<Industry, string> = {
  aggregate: "Aggregate and construction hauling",
  freight: "General freight",
  both: "Both",
};
export const INDUSTRY_HINTS: Record<Industry, string> = {
  aggregate: "Dump trucks, scale tickets, tons and loads.",
  freight: "Bills of lading and proof of delivery.",
  both: "Tickets and bills of lading side by side.",
};

/** Any stored value, made safe: unknown or missing means aggregate (every company before this setting existed). */
export function industryOf(value: unknown): Industry {
  return (INDUSTRIES as readonly unknown[]).includes(value) ? (value as Industry) : "aggregate";
}

export interface Vocabulary {
  /** The delivery documents section: menu item, page title, breadcrumbs. */
  documents: string;
  /** One document, at the start of a title ("Ticket T-1042"). */
  document: string;
  /** Entering one. */
  enter: string;
  /** In a sentence: "a ticket", "all BOLs". */
  one: string;
  many: string;
  /** What the delivery documents section holds. */
  description: string;
}

const WORDS: Record<Industry, Vocabulary> = {
  aggregate: {
    documents: "Delivery Tickets", document: "Ticket", enter: "Enter ticket", one: "ticket", many: "tickets",
    description: "What was actually delivered, entered from paper or scale tickets. Separate from the dispatch plan and from billing.",
  },
  freight: {
    documents: "Bills of Lading", document: "BOL", enter: "Enter BOL", one: "BOL", many: "BOLs",
    description: "What was actually delivered, entered from bills of lading and proof of delivery. Separate from the dispatch plan and from billing.",
  },
  both: {
    documents: "Tickets and BOLs", document: "Ticket", enter: "Enter ticket or BOL", one: "ticket or BOL", many: "tickets and BOLs",
    description: "What was actually delivered, entered from scale tickets, bills of lading and proof of delivery. Separate from the dispatch plan and from billing.",
  },
};

export function vocabulary(industry: unknown): Vocabulary {
  return WORDS[industryOf(industry)];
}

/** Menu labels that follow the industry, by path (the sidebar applies them over its defaults). */
export function navLabels(industry: unknown): Record<string, string> {
  return { "/tickets": vocabulary(industry).documents };
}

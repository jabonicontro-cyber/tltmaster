// Industry profile (owner 2026-11-05, master plan MK1): aggregate hauling stays Taviron's focus, and general freight
// carriers should feel at home too. A company chooses what it hauls in Settings; the choice changes the words people
// see, the equipment and place types offered and which aggregate-only or freight-only sections show (MK4), never the
// rules or the data: one application for every company.

export const INDUSTRIES = ["aggregate", "freight", "both"] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const INDUSTRY_LABELS: Record<Industry, string> = {
  aggregate: "Aggregate and construction hauling",
  freight: "General freight",
  both: "Both",
};
export const INDUSTRY_HINTS: Record<Industry, string> = {
  aggregate: "Dump trucks, scale tickets, tons and loads.",
  freight: "Tractors, vans and reefers, shippers and receivers, bills of lading and per-mile rates.",
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
  /** One delivery document, spelled out for drivers ("Delivery ticket", "Bill of lading"). */
  single: string;
  /** In a sentence: "a ticket", "all BOLs". */
  one: string;
  many: string;
  /** What the delivery documents section holds. */
  description: string;
  /** Plural at the start of a label ("Tickets to review", "BOLs to review"). */
  manyTitle: string;
  /** The number printed on the paper document ("paper or scale ticket number", "BOL number"). */
  number: string;
  /** Where a load is delivered, in a sentence and as a label ("job site", "Job site"; "delivery location"). */
  site: string;
  sites: string;
  Site: string;
  /** What is hauled ("material", "commodity"). */
  material: string;
  materials: string;
  Material: string;
  /** The catalog and rates page (menu and title). */
  pricing: string;
  /** The places trucks use, in a sentence. */
  places: string;
  /** Where an order's lines come from, as the quote and order editors explain it. */
  linesHint: string;
  /** Placeholder for job instructions on quotes and orders. */
  instructionsHint: string;
  /** What a customer may report, in the support page's description. */
  supportExamples: string;
}

const WORDS: Record<Industry, Vocabulary> = {
  aggregate: {
    documents: "Delivery Tickets", document: "Ticket", enter: "Enter ticket", single: "Delivery ticket", one: "ticket", many: "tickets",
    description: "What was actually delivered, entered from paper or scale tickets. Separate from the dispatch plan and from billing.",
    manyTitle: "Tickets", number: "paper or scale ticket number",
    site: "job site", sites: "job sites", Site: "Job site",
    material: "material", materials: "materials", Material: "Material",
    pricing: "Materials & Pricing", places: "yards, quarries and job sites",
    linesHint: "Materials and hauling are separate lines.",
    instructionsHint: "Delivery window, where to dump, site access…",
    supportExamples: "delivery problems, billing questions, wrong material, anything else",
  },
  freight: {
    documents: "Bills of Lading", document: "BOL", enter: "Enter BOL", single: "Bill of lading", one: "BOL", many: "BOLs",
    description: "What was actually delivered, entered from bills of lading and proof of delivery. Separate from the dispatch plan and from billing.",
    manyTitle: "BOLs", number: "BOL number",
    site: "delivery location", sites: "delivery locations", Site: "Delivery location",
    material: "commodity", materials: "commodities", Material: "Commodity",
    pricing: "Rates & Charges", places: "yards, shippers and receivers",
    linesHint: "Linehaul and accessorial charges (detention, lumper, fuel) are separate lines.",
    instructionsHint: "Appointment, dock or door, unloading, seal or pallet notes…",
    supportExamples: "late or missed appointments, damage or shortage, billing questions, anything else",
  },
  both: {
    documents: "Tickets and BOLs", document: "Ticket", enter: "Enter ticket or BOL", single: "Ticket or BOL", one: "ticket or BOL", many: "tickets and BOLs",
    description: "What was actually delivered, entered from scale tickets, bills of lading and proof of delivery. Separate from the dispatch plan and from billing.",
    manyTitle: "Tickets and BOLs", number: "ticket or BOL number",
    site: "job site or delivery location", sites: "job sites and delivery locations", Site: "Job site or delivery location",
    material: "material or commodity", materials: "materials and commodities", Material: "Material or commodity",
    pricing: "Materials & Pricing", places: "yards, quarries, shippers, receivers and job sites",
    linesHint: "Materials, hauling and accessorial charges are separate lines.",
    instructionsHint: "Delivery window, where to dump, dock or door, site access…",
    supportExamples: "delivery problems, damage or wrong material, billing questions, anything else",
  },
};

export function vocabulary(industry: unknown): Vocabulary {
  return WORDS[industryOf(industry)];
}

/** Menu labels that follow the industry, by path (the sidebar applies them over its defaults). */
export function navLabels(industry: unknown): Record<string, string> {
  const w = vocabulary(industry);
  return { "/tickets": w.documents, "/materials": w.pricing };
}

/** True when the company hauls aggregate (alone or with freight): the material catalog, dump bodies, tons and quarries apply. */
export const haulsAggregate = (industry: unknown) => industryOf(industry) !== "freight";
/** True when the company hauls freight (alone or with aggregate): stops, BOLs, vans and reefers apply. */
export const haulsFreight = (industry: unknown) => industryOf(industry) !== "aggregate";

// Fixed sentences written for aggregate hauling (Command Center reasons, billing readiness, review flags), reworded for a
// freight carrier where they reach the page (MK4). Longest phrases first; capitalisation follows the original word.
// Aggregate and "both" companies get the text unchanged (they know tickets).
const FREIGHT_PHRASES: Array<[RegExp, string]> = [
  [/\bpaper (?:\/|or) scale ticket numbers?\b/gi, "BOL number"],
  [/\bscale ticket numbers?\b/gi, "BOL number"],
  [/\bdelivery tickets\b/gi, "bills of lading"],
  [/\bdelivery ticket\b/gi, "bill of lading"],
  [/\bscale tickets?\b/gi, "BOL"],
  [/\bticket numbers?\b/gi, "BOL number"],
  [/\btickets\b/gi, "BOLs"],
  [/\bticket\b/gi, "BOL"],
  [/\bjob sites\b/gi, "delivery locations"],
  [/\bjob site\b/gi, "delivery location"],
  [/\bjob-site\b/gi, "delivery-location"],
  [/\bmaterials\b/gi, "commodities"],
  [/\bmaterial\b/gi, "commodity"],
];

const matchCase = (original: string, replacement: string) =>
  original[0] === original[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;

/** The same sentence in a freight carrier's words ("1 delivered load without a ticket" → "… without a BOL"). */
export function adaptWording(text: string, industry: unknown): string {
  if (industryOf(industry) !== "freight" || !text) return text;
  let out = text;
  for (const [re, to] of FREIGHT_PHRASES) out = out.replace(re, (m) => matchCase(m, to));
  return out;
}

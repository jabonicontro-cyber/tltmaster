// Outreach (owner 2026-11-05, master plan B139): reading a carrier list (the FMCSA Company Census export or any CSV),
// and preparing a personal email with an FAQ that the platform team sends from their own mailbox. Pure functions, used
// by the admin pages (client and server) and the tests. Nothing here sends anything.
//
// Rules: every email names the sender, carries a real postal address and an unsubscribe link (CAN-SPAM), and says
// where the address came from. Claims stay within what Taviron does today (the published feature catalog); prices come
// from src/lib/site/pricing.ts.

import { TIERS, usd } from "@/lib/site/pricing";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";

export const OUTREACH_STATUSES = ["new", "contacted", "replied", "interested", "not_interested", "do_not_contact"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];
export const OUTREACH_STATUS_LABELS: Record<OutreachStatus, string> = {
  new: "Not contacted", contacted: "Contacted", replied: "Replied", interested: "Interested", not_interested: "Not interested", do_not_contact: "Do not contact",
};
export const SEGMENTS = ["aggregate", "freight", "other"] as const;
export type Segment = (typeof SEGMENTS)[number];
export const SEGMENT_LABELS: Record<Segment, string> = { aggregate: "Aggregate and construction", freight: "General freight", other: "Other" };

export interface ProspectInput {
  email: string;
  company_name: string;
  contact_name: string;
  phone: string;
  city: string;
  state: string;
  dot_number: string;
  power_units: number | null;
  drivers: number | null;
  segment: Segment;
}

// ---------- Reading a carrier list ----------

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Column names we recognise, most specific first. FMCSA names vary between file versions, so several are accepted. */
const COLUMNS: Record<Exclude<keyof ProspectInput, "segment">, string[]> = {
  email: ["emailaddress", "email", "emailaddr"],
  company_name: ["legalname", "companyname", "company", "name", "carriername", "businessname"],
  contact_name: ["companyofficer1", "contactname", "contact", "officer", "owner"],
  phone: ["telephone", "phone", "phonenumber", "tel"],
  city: ["phycity", "city", "physicalcity"],
  state: ["phystate", "state", "physicalstate", "st"],
  dot_number: ["dotnumber", "usdotnumber", "usdot", "dot"],
  power_units: ["nbrpowerunit", "powerunits", "powerunit", "trucks", "totalpowerunits", "fleetsize"],
  drivers: ["drivertotal", "totaldrivers", "drivers", "nbrdrivers"],
};
const DBA = ["dbaname", "dba"];
const ACTIVE = ["statuscode", "actstat", "status", "carrierstatus"];

/** Cargo columns that mark construction and aggregate haulers, or general freight (any flag set). */
const AGGREGATE_CARGO = /(constmatl|construct|bldgmat|buildingmat|aggreg|gravel|sand|dirt)$/;
const FREIGHT_CARGO = /(genfreight|generalfreight|drygoods|produce|meat|refrig|intermodal|machlrg|metalsheet|paperprod|beverages)$/;
const FLAG_SET = /^(x|y|yes|true|1|t)$/i;

export interface ColumnMap {
  fields: Partial<Record<Exclude<keyof ProspectInput, "segment">, number>>;
  dba: number | null;
  active: number | null;
  aggregateCargo: number[];
  freightCargo: number[];
}

export function mapColumns(headers: string[]): ColumnMap {
  const n = headers.map(norm);
  const used = new Set<number>();
  const find = (names: string[]) => {
    for (const name of names) {
      const i = n.findIndex((h, k) => h === name && !used.has(k));
      if (i >= 0) {
        used.add(i);
        return i;
      }
    }
    return undefined;
  };
  const fields: ColumnMap["fields"] = {};
  for (const key of Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>) {
    const i = find(COLUMNS[key]);
    if (i !== undefined) fields[key] = i;
  }
  const dba = find(DBA) ?? null;
  const active = find(ACTIVE) ?? null;
  const cargo = (re: RegExp) => n.map((h, i) => (h.startsWith("crgo") || h.startsWith("cargo")) && re.test(h) ? i : -1).filter((i) => i >= 0);
  return { fields, dba, active, aggregateCargo: cargo(AGGREGATE_CARGO), freightCargo: cargo(FREIGHT_CARGO) };
}

export function missingColumns(map: ColumnMap): string[] {
  const out: string[] = [];
  if (map.fields.email === undefined) out.push("email address");
  if (map.fields.company_name === undefined) out.push("company name");
  return out;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Inc|Co|Ltd)\b/g, (m) => m.toUpperCase() === "CO" ? "Co" : m.toUpperCase());

export interface ReadFilters {
  states: string[];
  minUnits: number | null;
  maxUnits: number | null;
  segments: Segment[];
  activeOnly: boolean;
}

export interface ReadResult {
  rows: ProspectInput[];
  total: number;
  skipped: { noEmail: number; filtered: number; inactive: number; duplicate: number };
}

/** The rows of a carrier list that match the filters, cleaned. Census names are often all capitals; they are softened. */
export function readCarrierRows(table: string[][], filters: ReadFilters): ReadResult {
  const [headers, ...data] = table;
  const map = mapColumns(headers ?? []);
  const skipped = { noEmail: 0, filtered: 0, inactive: 0, duplicate: 0 };
  const seen = new Set<string>();
  const rows: ProspectInput[] = [];
  const states = new Set(filters.states.map((s) => s.trim().toUpperCase()).filter(Boolean));
  const cell = (r: string[], i: number | undefined | null) => (i === undefined || i === null ? "" : (r[i] ?? "").trim());
  const num = (v: string) => (/^\d{1,6}$/.test(v) ? Number(v) : null);
  for (const r of data) {
    const email = cell(r, map.fields.email).toLowerCase();
    if (!EMAIL.test(email)) {
      skipped.noEmail++;
      continue;
    }
    if (filters.activeOnly && map.active !== null) {
      const s = cell(r, map.active).toUpperCase();
      if (s && !["A", "ACTIVE", "Y"].includes(s)) {
        skipped.inactive++;
        continue;
      }
    }
    const aggregate = map.aggregateCargo.some((i) => FLAG_SET.test(cell(r, i)));
    const freight = map.freightCargo.some((i) => FLAG_SET.test(cell(r, i)));
    const segment: Segment = aggregate ? "aggregate" : freight ? "freight" : "other";
    const state = cell(r, map.fields.state).toUpperCase().slice(0, 2);
    const units = num(cell(r, map.fields.power_units));
    if ((states.size && !states.has(state))
        || (filters.minUnits !== null && (units ?? 0) < filters.minUnits)
        || (filters.maxUnits !== null && (units ?? 0) > filters.maxUnits)
        || (filters.segments.length && !filters.segments.includes(segment))) {
      skipped.filtered++;
      continue;
    }
    if (seen.has(email)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(email);
    const legal = cell(r, map.fields.company_name);
    const dba = cell(r, map.dba);
    const company = (dba || legal).slice(0, 160);
    if (!company) {
      skipped.noEmail++;
      continue;
    }
    const soft = (s: string) => (s === s.toUpperCase() ? titleCase(s) : s);
    rows.push({
      email,
      company_name: soft(company),
      contact_name: soft(cell(r, map.fields.contact_name)).slice(0, 120),
      phone: cell(r, map.fields.phone).slice(0, 40),
      city: soft(cell(r, map.fields.city)).slice(0, 80),
      state,
      dot_number: /^\d{1,10}$/.test(cell(r, map.fields.dot_number)) ? cell(r, map.fields.dot_number) : "",
      power_units: units,
      drivers: num(cell(r, map.fields.drivers)),
      segment,
    });
  }
  return { rows, total: data.length, skipped };
}

// ---------- The email ----------

export interface FaqItem { q: string; a: string }
export interface OutreachSettings {
  sender_name: string;
  reply_to: string;
  postal_address: string;
  subject: string;
  body: string;
  faq: FaqItem[];
}

export const DEFAULT_SUBJECT = "Less paperwork for {{company}}?";

export const DEFAULT_BODY = `Hi {{first_name}},

I'm {{sender_name}} with Taviron. We build software for hauling and trucking companies, and {{company}} looks like the kind of fleet we built it for.

Taviron keeps each job in one place, from the customer's order to the invoice:
- Drivers photograph their tickets on the phone they already have, so billing does not wait on paper.
- Tomorrow's dispatch is proposed for you to review and approve.
- A truck with an open safety problem stays off the schedule until the shop clears it.
- Invoices, driver pay statements and fuel tax records come from the same tickets.

Would you be open to a 20-minute look at how it would work for your {{fleet}}? Reply with a time that suits you, or tell me what slows your week down the most and I'll show you how Taviron handles it.

Thanks,
{{sender_name}}`;

export function defaultFaq(): FaqItem[] {
  const starter = TIERS[0];
  return [
    { q: "What does it cost?", a: `Plans start at ${usd(starter.monthlyCents)} a month for up to ${starter.trucks} trucks, plus a one-time onboarding fee. The price depends on how many trucks and dispatch yards you run.` },
    { q: "How do we get started?", a: "We set up your company with you, bring in your customers, trucks and drivers from the spreadsheets you already have, and train your team in a live session." },
    { q: "Do my drivers need new devices?", a: "No. Drivers use Taviron on their own phones from the home screen, and it keeps working where the signal is weak." },
    { q: "Can we see it before deciding?", a: "Yes. We'll walk you through Taviron with sample data that looks like your operation before you decide anything." },
    { q: "Is our information private?", a: "Each company's information is kept separate. Only the people you invite can sign in, and you decide what each role can see and do." },
    { q: "We don't haul aggregate. Does it still fit?", a: "Taviron is built for dump truck and aggregate hauling first. If you haul other freight, tell us how you work and we'll tell you honestly how well it fits." },
  ];
}

export function withDefaults(s: Partial<OutreachSettings> | null): OutreachSettings {
  return {
    sender_name: s?.sender_name ?? "",
    reply_to: s?.reply_to ?? "",
    postal_address: s?.postal_address ?? "",
    subject: s?.subject?.trim() ? s.subject : DEFAULT_SUBJECT,
    body: s?.body?.trim() ? s.body : DEFAULT_BODY,
    faq: Array.isArray(s?.faq) && s.faq.length ? s.faq : defaultFaq(),
  };
}

/** What still has to be filled in before any email can be prepared (CAN-SPAM: who it is from and a postal address). */
export function settingsProblems(s: OutreachSettings): string[] {
  const out: string[] = [];
  if (!s.sender_name.trim()) out.push("Add the sender's name.");
  if (s.postal_address.trim().length < 10) out.push("Add the postal address every email must show (a street address or P.O. box).");
  return out;
}

export interface ProspectForEmail {
  email: string;
  company_name: string;
  contact_name: string;
  city: string;
  power_units: number | null;
  source: "fmcsa_census" | "csv" | "manual";
  unsubscribe_token: string;
}

export function firstName(contact: string): string {
  const first = contact.trim().split(/[\s,]+/)[0] ?? "";
  if (!first || first.length < 2 || /\d/.test(first)) return "there";
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

export function unsubscribeUrl(token: string, base = PUBLIC_WEBSITE_URL): string {
  return `${base.replace(/\/$/, "")}/unsubscribe/${token}`;
}

function fill(text: string, p: ProspectForEmail, s: OutreachSettings): string {
  const fleet = p.power_units && p.power_units > 0 ? `${p.power_units} ${p.power_units === 1 ? "truck" : "trucks"}` : "fleet";
  const values: Record<string, string> = {
    company: p.company_name, first_name: firstName(p.contact_name), city: p.city || "your area", fleet, sender_name: s.sender_name.trim(),
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => values[k] ?? m);
}

/** The finished email for one prospect: subject, and the body with the FAQ and the required footer. */
export function renderEmail(p: ProspectForEmail, s: OutreachSettings, base = PUBLIC_WEBSITE_URL): { to: string; subject: string; body: string } {
  const faq = s.faq.filter((f) => f.q.trim() && f.a.trim());
  const faqText = faq.length ? `\n\nCommon questions\n\n${faq.map((f) => `${f.q.trim()}\n${f.a.trim()}`).join("\n\n")}` : "";
  const source = p.source === "fmcsa_census"
    ? `You're receiving this because ${p.company_name}'s email is listed in the public FMCSA motor carrier registry.`
    : `You're receiving this because we thought Taviron could help ${p.company_name}.`;
  const footer = `\n\n--\n${source}\nIf you'd rather not hear from us again, unsubscribe here: ${unsubscribeUrl(p.unsubscribe_token, base)}\n${s.sender_name.trim()}, Taviron\n${s.postal_address.trim()}`;
  return { to: p.email, subject: fill(s.subject, p, s).slice(0, 200), body: `${fill(s.body, p, s).trim()}${faqText}${footer}` };
}

/** Links that open the prepared email: the computer's mail app, and Gmail in the browser (no length trouble). */
export function composeLinks(e: { to: string; subject: string; body: string }): { mailto: string; gmail: string } {
  const q = new URLSearchParams({ subject: e.subject, body: e.body });
  const mailto = `mailto:${encodeURIComponent(e.to)}?${q.toString().replace(/\+/g, "%20")}`;
  const g = new URLSearchParams({ view: "cm", fs: "1", to: e.to, su: e.subject, body: e.body });
  return { mailto, gmail: `https://mail.google.com/mail/?${g.toString()}` };
}

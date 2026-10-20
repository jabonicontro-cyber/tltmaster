import "server-only";
import { z } from "zod";
import { capability } from "@/lib/ai/capabilities";
import { ASSISTANT_INSTRUCTIONS, ASSISTANT_JSON_SCHEMA, checkAnswer, pseudonymizeQuestion, type AssistantAnswer, type Pseudonyms } from "@/lib/ai/assistant";
import { EXCEPTION_KINDS, KIND_LABELS, exceptionAction, reasonText, type CommandSummary, type ExceptionItem, type ExceptionKind } from "@/lib/command-center/rules";
import { HELP_ARTICLES } from "@/lib/help/articles";
import { searchArticles, visibleArticles } from "@/lib/help/search";
import type { OutlookDay } from "@/lib/live/outlook";
import { PM_STATES, WO_STATUSES, WO_URGENCIES, type PmState, type WoStatus, type WoUrgency } from "@/lib/maintenance";
import type { Permission } from "@/lib/permissions";
import type { CapabilityRequest } from "./run";
import { toolsFor, type Tool } from "./tools";

// "Ask Taviron" as a capability request (docs/AI.md §12): context, read-only tools and validation. Every tool reads the
// caller's own company through their session (row-level security) and returns codes, catalog labels, dates and counts —
// never names, reference numbers, ids or free text people typed into records.

/** What the assistant may read; implemented with the caller's session in src/server/data/assistant.ts. */
export interface AssistantSource {
  summary(): Promise<CommandSummary | null>;
  queue(kind: ExceptionKind | null, limit: number): Promise<ExceptionItem[] | null>;
  /** One order by its id or exact reference ("ORD-1042"); null when none the caller may see. */
  order(lookup: { id: string } | { reference: string }): Promise<AssistantOrder | null>;
  maintenance(): Promise<{ workOrders: AssistantWorkOrder[]; pm: AssistantPm[] } | null>;
  outlook(): Promise<OutlookDay[] | null>;
  /** Customers and drivers the caller can see, to replace their names in the question with codes. */
  names(): Promise<Array<{ kind: "customer" | "driver"; key: string; label: string; href: string | null }>>;
}

export interface AssistantOrder {
  id: string;
  number: string;
  status: string;
  requestedDate: string | null;
  customer: { id: string; name: string } | null;
  loads: Record<string, number>;
  /** From order_fulfillment; null before that view exists or without permission. */
  fulfillment: { loadsPlanned: number; loadsUpcoming: number; loadsWithoutAcceptedTicket: number; ticketsPending: number; ticketsAccepted: number; fulfilled: boolean } | null;
  /** From billing_order_status (billing.view only). */
  billing: { readiness: string; exceptions: number; handedOff: boolean } | null;
}

export interface AssistantWorkOrder {
  id: string;
  number: string;
  unit: { kind: "truck" | "trailer"; id: string; number: string } | null;
  status: WoStatus;
  urgency: WoUrgency;
  safetyCritical: boolean;
  dueOn: string | null;
}

export interface AssistantPm {
  truckId: string;
  unitNumber: string;
  state: PmState;
  nextDueOn: string | null;
  readingsStale: boolean;
}

export interface AssistantToolData {
  p: Pseudonyms;
  source: AssistantSource;
  /** Everything the model was given (context and tool results): the grounding for the number check. */
  grounding: string[];
  permissions: readonly Permission[];
}

const truckHref = (kind: "truck" | "trailer", id: string) => `/fleet/${kind === "trailer" ? "trailers" : "trucks"}/${id}`;

/** One attention item as the model sees it: codes, the catalog label, dates, priority and catalog reasons. */
function attentionItem(e: ExceptionItem, d: AssistantToolData) {
  const can = { ticketsEdit: d.permissions.includes("tickets.edit"), dispatch: d.permissions.includes("dispatch.view") };
  const href = exceptionAction(e, can).href;
  const order = e.order_id && e.order_number ? d.p.code("order", e.order_id, e.order_number, `/orders/${e.order_id}`) : null;
  let item: string | null = null;
  if (e.ticket_id && e.ticket_number) item = d.p.code("ticket", e.ticket_id, `Ticket ${e.ticket_number}`, href);
  else if (e.load_id) item = d.p.code("load", e.load_id, `${e.order_number ?? "Order"}${e.load_number !== null ? ` · load ${e.load_number}` : ""}`, href);
  else if (e.equipment_id && e.unit_number) item = d.p.code(e.equipment_kind === "trailer" ? "trailer" : "truck", e.equipment_id, `${e.equipment_kind === "trailer" ? "Trailer" : "Truck"} ${e.unit_number}`, href, false);
  const facts: Record<string, unknown> = {
    item: item ?? order,
    ...(item && order ? { order } : {}),
    kind: KIND_LABELS[e.kind],
    priority: e.priority,
    ...(e.load_date ? { loadDate: e.load_date } : {}),
    ...(e.since ? { since: e.since.slice(0, 10) } : {}),
    reasons: e.reasons.map(reasonText),
  };
  // Structured details only (counts, dates, states from fixed lists); free text such as a driver's description is not sent.
  if (typeof e.details.upcoming_loads === "number") facts.upcomingLoadsOnIt = e.details.upcoming_loads;
  if (typeof e.details.expected_return_date === "string") facts.expectedBack = e.details.expected_return_date;
  if (typeof e.details.exceptions_count === "number") facts.billingDifferences = e.details.exceptions_count;
  if (typeof e.details.requested_date === "string") facts.requestedDate = e.details.requested_date;
  if (typeof e.details.active_assignments === "number") facts.loadsWithTruck = e.details.active_assignments;
  if (e.assigned_to) facts.assignedToSomeone = true;
  return facts;
}

const kindArg = z.object({ kind: z.enum(EXCEPTION_KINDS).nullable() }).strict();
const orderArg = z.object({ order: z.string().regex(/^[OQ]\d{1,4}$/) }).strict();
const helpArg = z.object({ query: z.string().min(2).max(120) }).strict();
const none = z.object({}).strict();

function record<T>(d: AssistantToolData, result: T): T {
  d.grounding.push(JSON.stringify(result));
  return result;
}

export const ASSISTANT_TOOLS: Tool<AssistantToolData>[] = [
  {
    name: "attention_queue",
    description: "The company's prioritized attention queue (Command Center), most important first: urgent orders, loads without a truck, assignment problems, missing or unreviewed tickets, billing blocks, equipment out of service, driver reports. Optional kind filter.",
    kind: "read",
    permission: ["orders.view", "dispatch.view", "tickets.view", "billing.view", "fleet.view"],
    parameters: { type: "object", properties: { kind: { type: ["string", "null"], enum: [...EXCEPTION_KINDS, null] } }, required: ["kind"], additionalProperties: false },
    args: kindArg as z.ZodType<unknown>,
    run: async (args, ctx) => {
      const items = await ctx.data.source.queue((args as z.infer<typeof kindArg>).kind, 15);
      if (!items) return record(ctx.data, { error: "The attention queue could not be loaded." });
      return record(ctx.data, { items: items.map((e) => attentionItem(e, ctx.data)), shown: items.length });
    },
  },
  {
    name: "order_status",
    description: "Status of one order by its code (O1 or a typed reference Q1): status, requested date, loads by status, tickets, fulfillment and billing readiness.",
    kind: "read",
    permission: "orders.view",
    parameters: { type: "object", properties: { order: { type: "string" } }, required: ["order"], additionalProperties: false },
    args: orderArg as z.ZodType<unknown>,
    run: async (args, ctx) => {
      const code = (args as z.infer<typeof orderArg>).order;
      const entry = ctx.data.p.entry(code);
      // Only references the person typed or orders already shown in this request resolve; nothing else can be probed.
      const lookup = entry?.kind === "order" ? { id: entry.key } : entry?.kind === "typed_ref" && /^ORD-/.test(entry.key) ? { reference: entry.key } : null;
      if (!lookup) return record(ctx.data, { order: code, error: "That is not an order reference." });
      const o = await ctx.data.source.order(lookup);
      if (!o) return record(ctx.data, { order: code, error: "No order with that reference that you can see." });
      if (entry?.kind === "typed_ref") entry.href = `/orders/${o.id}`;
      return record(ctx.data, {
        order: code,
        status: o.status,
        requestedDate: o.requestedDate,
        customer: o.customer ? ctx.data.p.code("customer", o.customer.id, o.customer.name, `/customers/${o.customer.id}`) : null,
        loads: o.loads,
        fulfillment: o.fulfillment,
        billing: o.billing,
      });
    },
  },
  {
    name: "maintenance_attention",
    description: "Open maintenance work orders (status, urgency, safety-critical, due date, unit) and preventive maintenance that is overdue or due soon.",
    kind: "read",
    permission: "maintenance.view",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    args: none as z.ZodType<unknown>,
    run: async (_args, ctx) => {
      const m = await ctx.data.source.maintenance();
      if (!m) return record(ctx.data, { error: "Maintenance could not be loaded." });
      const p = ctx.data.p;
      return record(ctx.data, {
        workOrders: m.workOrders.slice(0, 20).map((w) => ({
          workOrder: p.code("work_order", w.id, w.number, `/maintenance/work-orders/${w.id}`),
          unit: w.unit ? p.code(w.unit.kind, w.unit.id, `${w.unit.kind === "trailer" ? "Trailer" : "Truck"} ${w.unit.number}`, truckHref(w.unit.kind, w.unit.id), false) : null,
          status: WO_STATUSES[w.status],
          urgency: WO_URGENCIES[w.urgency],
          safetyCritical: w.safetyCritical,
          dueOn: w.dueOn,
        })),
        openWorkOrders: m.workOrders.length,
        preventive: m.pm.filter((x) => x.state === "overdue" || x.state === "due_soon").slice(0, 20).map((x) => ({
          unit: p.code("truck", x.truckId, `Truck ${x.unitNumber}`, truckHref("truck", x.truckId), false),
          state: PM_STATES[x.state],
          nextDueOn: x.nextDueOn,
          readingsStale: x.readingsStale,
        })),
      });
    },
  },
  {
    name: "week_outlook",
    description: "The next 7 days from today: per day planned loads, assigned and unassigned loads, trucks ready and down, drivers available and off, and assigned loads whose truck cannot run.",
    kind: "read",
    permission: "dispatch.view",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    args: none as z.ZodType<unknown>,
    run: async (_args, ctx) => {
      const days = await ctx.data.source.outlook();
      if (!days) return record(ctx.data, { error: "The outlook could not be loaded." });
      return record(ctx.data, {
        days: days.map((d) => ({ date: d.date, loads: d.loads, assigned: d.assigned, unassigned: d.unassigned, trucksReady: d.trucksReady, trucksDown: d.trucksDown, driversAvailable: d.driversAvailable, driversOff: d.driversOff, conflicts: d.conflicts })),
      });
    },
  },
  {
    name: "help_search",
    description: "Search Taviron's Help Center for how to use a page or workflow. Returns article codes, titles, summaries and steps.",
    kind: "read",
    permission: ["orders.view", "dispatch.view", "maintenance.view", "tickets.view", "billing.view"],
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    args: helpArg as z.ZodType<unknown>,
    run: (args, ctx) => {
      const found = searchArticles(visibleArticles(HELP_ARTICLES, ctx.data.permissions), (args as z.infer<typeof helpArg>).query).slice(0, 3);
      return record(ctx.data, {
        articles: found.map((a) => ({
          // Product documentation, not company data: the title may be shown as is.
          article: ctx.data.p.code("help", a.id, a.title, `/help/${a.id}`, false),
          title: a.title,
          summary: a.summary,
          tasks: a.tasks.slice(0, 2).map((t) => ({ title: t.title, steps: t.steps.slice(0, 6) })),
        })),
      });
    },
  },
];

const SUMMARY_FIELDS = [
  "orders_today", "orders_unscheduled", "urgent_orders", "loads_today", "loads_today_assigned", "unassigned_loads", "assignment_problems",
  "trucks_out_of_service", "trailers_out_of_service", "tickets_to_review", "missing_tickets", "billing_blocked", "billing_ready", "driver_reports",
] as const;

/** Today's counts the person may see (null = not available to them, left out rather than shown as 0). */
export function summaryContext(s: CommandSummary | null): Record<string, number> | null {
  if (!s) return null;
  const out: Record<string, number> = { attention_items: s.exceptions.total, urgent_items: s.exceptions.urgent };
  for (const k of SUMMARY_FIELDS) {
    const v = s[k];
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

function pushSecrets(into: string[], more: string[]): string[] {
  for (const s of more) if (!into.includes(s)) into.push(s);
  return into;
}

/** The request for one question. `p` and `grounding` are filled while the model works and checked at the end. */
export async function assistantRequest(question: string, data: AssistantToolData, today: string): Promise<CapabilityRequest<AssistantToolData, AssistantAnswer>> {
  const [names, summary] = await Promise.all([data.source.names(), data.source.summary()]);
  const q = pseudonymizeQuestion(question, names, data.p);
  const tools = toolsFor(ASSISTANT_TOOLS, data.permissions);
  const input = JSON.stringify({ today, question: q, summary: summaryContext(summary), tools: tools.map((t) => t.name) });
  data.grounding.push(input);
  return {
    capability: capability("ops_assistant"),
    instructions: ASSISTANT_INSTRUCTIONS,
    input,
    output: { name: "ops_answer", schema: ASSISTANT_JSON_SCHEMA },
    tools,
    // Every name the person can see, not only the ones in the question: a tool result must never carry one either.
    // Very short names are left out of this list (they would match ordinary words); tools never return names anyway.
    secrets: pushSecrets(data.p.secrets, names.map((n) => n.label.trim()).filter((l) => l.length >= 5)),
    maxOutputTokens: 600,
    validate: (raw) => {
      const findings = checkAnswer(raw, data.grounding.join("\n"), new Set(Object.keys(data.p.entries)), data.p.secrets);
      return findings.length ? { ok: false, detail: findings.map((f) => f.detail).join(" ") } : { ok: true, value: raw as AssistantAnswer };
    },
  };
}

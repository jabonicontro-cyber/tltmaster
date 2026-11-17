// Workflow modules (owner decisions 2026-11-16, master plan MOD1, docs/MODULES.md). A company switches its main
// workflows on or off; company_settings.modules_off holds the ones switched OFF (empty: everything on). Switching off
// hides a module (menu, pages, Command Center items, getting started, search, help, notifications, links); it never
// deletes a record or changes a permission or rule. The database (20261120023000) keeps the same keys and dependencies.
//
// Safety, Driver Reports and Communications are not modules: they can never be switched off.

export const MODULE_KEYS = ["quotes", "orders", "dispatch", "tickets", "billing", "order_to_cash", "payroll", "maintenance", "customer_portal", "support", "schedule", "time_off", "reports"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleInfo {
  key: ModuleKey;
  label: string;
  /** One plain line under the switch. */
  hint: string;
  /** Pages that belong to the module (a path and everything under it). */
  hrefs: readonly string[];
  /** Modules it cannot work without. */
  needs: readonly ModuleKey[];
}

export const MODULES: readonly ModuleInfo[] = [
  { key: "quotes", label: "Quotes", hint: "Price a job for a customer before it is ordered.", hrefs: ["/quotes"], needs: [] },
  { key: "orders", label: "Orders and jobs", hint: "Each customer job with its material and agreed prices.", hrefs: ["/orders", "/order-documents"], needs: [] },
  { key: "dispatch", label: "Dispatch", hint: "Plan loads and assign trucks and drivers.", hrefs: ["/dispatch", "/route-planner", "/hired-trucks"], needs: ["orders"] },
  { key: "tickets", label: "Delivery tickets", hint: "Enter and check the tickets for what was delivered.", hrefs: ["/tickets"], needs: ["orders"] },
  { key: "billing", label: "Billing", hint: "Turn checked tickets into invoices.", hrefs: ["/billing", "/accountant"], needs: ["tickets"] },
  { key: "order_to_cash", label: "Order to Cash", hint: "Every job from delivery to payment, on one page.", hrefs: ["/order-to-cash"], needs: ["orders", "billing"] },
  { key: "payroll", label: "Payroll", hint: "Driver pay from tickets that name a driver.", hrefs: ["/payroll"], needs: ["tickets"] },
  { key: "maintenance", label: "Maintenance", hint: "Your own shop: work orders, mechanics, parts.", hrefs: ["/maintenance"], needs: [] },
  { key: "customer_portal", label: "Customer Portal", hint: "Your customers' own sign-in.", hrefs: ["/customer-portal"], needs: [] },
  { key: "support", label: "Support", hint: "Requests from your customers' portal.", hrefs: ["/support"], needs: [] },
  { key: "schedule", label: "Schedule", hint: "Shift schedules for your people.", hrefs: ["/schedule"], needs: [] },
  { key: "time_off", label: "Time Off", hint: "Requests, approvals and balances.", hrefs: ["/time-off"], needs: [] },
  { key: "reports", label: "Reports", hint: "Operations and revenue reports.", hrefs: ["/reports"], needs: [] },
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));
export const moduleInfo = (key: ModuleKey): ModuleInfo => BY_KEY.get(key)!;

/** Any stored list, made safe: only known modules, each once, in a fixed order. */
export function modulesOff(value: unknown): ModuleKey[] {
  if (!Array.isArray(value)) return [];
  const set = new Set(value.filter((v): v is ModuleKey => typeof v === "string" && BY_KEY.has(v as ModuleKey)));
  return MODULE_KEYS.filter((k) => set.has(k));
}

export const moduleOn = (key: ModuleKey, off: readonly string[]): boolean => !off.includes(key);

/** The module a link belongs to (null: always on). Query strings and anchors are ignored. */
export function moduleOfHref(href: string): ModuleKey | null {
  const path = href.split(/[?#]/)[0] || "/";
  for (const m of MODULES) {
    if (m.hrefs.some((h) => path === h || path.startsWith(h + "/"))) return m.key;
  }
  return null;
}

/** Whether a link is shown: everything except the pages of switched-off modules. */
export function hrefShown(href: string, off: readonly string[]): boolean {
  const m = moduleOfHref(href);
  return m === null || !off.includes(m);
}

/**
 * The module whose screens a permission's content belongs to, for pages that gather several areas (Command Center,
 * briefing): with the module off that content is left out. The permission itself never changes.
 */
const PERMISSION_MODULE: Array<[RegExp, ModuleKey]> = [
  [/^quotes\./, "quotes"],
  [/^orders\./, "orders"],
  [/^dispatch\./, "dispatch"],
  [/^tickets\./, "tickets"],
  [/^billing\./, "billing"],
  [/^payroll\./, "payroll"],
  [/^maintenance\./, "maintenance"],
];

export function permissionModuleOn(permission: string, off: readonly string[]): boolean {
  const hit = PERMISSION_MODULE.find(([re]) => re.test(permission));
  return !hit || !off.includes(hit[1]);
}

/** Modules that need `key`, directly or through another. */
function dependentsOf(key: ModuleKey): ModuleKey[] {
  const out = new Set<ModuleKey>();
  const walk = (k: ModuleKey) => {
    for (const m of MODULES) if (m.needs.includes(k) && !out.has(m.key)) { out.add(m.key); walk(m.key); }
  };
  walk(key);
  return [...out];
}

/** Everything `key` needs, directly or through another. */
function requirementsOf(key: ModuleKey): ModuleKey[] {
  const out = new Set<ModuleKey>();
  const walk = (k: ModuleKey) => {
    for (const n of moduleInfo(k).needs) if (!out.has(n)) { out.add(n); walk(n); }
  };
  walk(key);
  return [...out];
}

/** Switch a module on or off, keeping dependencies: off takes what needs it along; on brings what it needs. */
export function toggleModule(off: readonly ModuleKey[], key: ModuleKey, on: boolean): { off: ModuleKey[]; alsoChanged: ModuleKey[] } {
  const set = new Set(off);
  const also: ModuleKey[] = [];
  if (on) {
    set.delete(key);
    for (const r of requirementsOf(key)) if (set.delete(r)) also.push(r);
  } else {
    set.add(key);
    for (const d of dependentsOf(key)) if (!set.has(d)) { set.add(d); also.push(d); }
  }
  return { off: MODULE_KEYS.filter((k) => set.has(k)), alsoChanged: also };
}

/** A broken dependency in a list, in plain words (null: fine). The database refuses the same ones. */
export function dependencyProblem(off: readonly ModuleKey[]): string | null {
  for (const m of MODULES) {
    if (off.includes(m.key)) continue;
    const missing = m.needs.filter((n) => off.includes(n));
    if (missing.length) return `${m.label} needs ${missing.map((n) => moduleInfo(n).label).join(" and ")}.`;
  }
  return null;
}

export const PRESET_KEYS = ["full", "tickets_to_billing", "quotes_only"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

/** Starting points (owner decision 2026-11-16); the same lists as private.module_preset. Maintenance stays on (safety core). */
export const PRESETS: Record<PresetKey, { label: string; hint: string; off: readonly ModuleKey[] }> = {
  full: { label: "Full operations", hint: "Everything: quotes, orders, dispatch, tickets, billing, payroll and the rest.", off: [] },
  tickets_to_billing: {
    label: "Tickets to billing",
    hint: "Enter delivery tickets against each customer's job and send them to billing. No dispatch board.",
    off: ["quotes", "dispatch", "order_to_cash", "payroll", "customer_portal", "support", "schedule", "time_off"],
  },
  quotes_only: {
    label: "Quotes only",
    hint: "Make quotes and mark the ones you win. No orders, dispatch or billing.",
    off: ["orders", "dispatch", "tickets", "billing", "order_to_cash", "payroll", "customer_portal", "support", "schedule", "time_off"],
  },
};

/** Which preset a list matches exactly (null: the company's own choice). */
export function presetOf(off: readonly string[]): PresetKey | null {
  const set = [...new Set(off)].sort().join(",");
  for (const k of PRESET_KEYS) if ([...PRESETS[k].off].sort().join(",") === set) return k;
  return null;
}

/**
 * What a new company on the Starter plan starts with switched off (owner decision 2026-11-14, SF1): everything optional
 * except Maintenance (safety core) and the daily core (orders, dispatch, tickets, billing). Applied once by the database
 * (private.starter_default_hidden_areas); owners switch any module back on in Settings.
 */
export const STARTER_OFF: readonly ModuleKey[] = ["quotes", "support", "customer_portal", "order_to_cash", "payroll", "schedule", "time_off", "reports"];

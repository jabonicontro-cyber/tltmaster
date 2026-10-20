// Customer Onboarding Kit (docs/ONBOARDING.md §5; migration 20261120001500). The fixed structure of the kit's forms:
// the questionnaire, the dispatch worksheet (with what the product really enforces), the integrations Taviron actually
// has, the go-live acceptance items, and the welcome email template. Answers are stored per company; this file only
// defines questions and labels — never secrets (the database refuses password/key/card/identifier fields too).

export type KitForm = "welcome_email" | "questionnaire" | "dispatch_worksheet" | "integrations" | "integration_checks" | "testing" | "go_live" | "post_launch";

export type FieldKind = "text" | "textarea" | "number" | "choice" | "date";
export interface KitField {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
  choices?: string[];
}
export interface KitSection {
  key: string;
  title: string;
  description?: string;
  fields: KitField[];
}

/** B. Company setup questionnaire. Required fields are what onboarding cannot start without. */
export const QUESTIONNAIRE: KitSection[] = [
  {
    key: "company", title: "Company and operating profile",
    fields: [
      { key: "legal_name", label: "Legal company name", kind: "text", required: true },
      { key: "operating_profile", label: "What you haul and for whom", kind: "textarea", required: true, hint: "For example: aggregate and dump work for contractors and municipalities." },
      { key: "locations", label: "Yards and locations (one per line)", kind: "textarea", required: true },
      { key: "time_zones", label: "Time zones you operate in", kind: "text", required: true },
      { key: "operating_hours", label: "Normal operating hours", kind: "text", required: true, hint: "For example: Mon–Fri 5:00–18:00, Sat 6:00–12:00." },
    ],
  },
  {
    key: "contacts", title: "Contacts and owners",
    description: "Names and roles only. Taviron never needs passwords or personal identification numbers.",
    fields: [
      { key: "primary_contact", label: "Primary contact (name, role, phone or email)", kind: "text", required: true },
      { key: "decision_maker", label: "Decision-maker who approves go-live", kind: "text", required: true },
      { key: "billing_contact", label: "Billing contact", kind: "text", required: true },
      { key: "operations_owner", label: "Dispatch / operations owner", kind: "text", required: true },
      { key: "fleet_owner", label: "Fleet and maintenance owner", kind: "text" },
      { key: "it_owner", label: "Technical or IT contact (for integrations)", kind: "text" },
    ],
  },
  {
    key: "people", title: "Users, roles and security",
    fields: [
      { key: "user_count", label: "How many people will use Taviron", kind: "number", required: true },
      { key: "roles", label: "Who needs which role (owner, office, dispatcher, mechanic, driver)", kind: "textarea", required: true },
      { key: "drivers_without_email", label: "Do drivers or mechanics need username sign-ins (no company email)?", kind: "choice", choices: ["Yes", "No", "Some"], required: true },
      { key: "security_requirements", label: "Security requirements", kind: "textarea", hint: "For example: two-step verification for office staff, shared computers in the shop." },
    ],
  },
  {
    key: "fleet", title: "Fleet, drivers and bases",
    fields: [
      { key: "truck_count", label: "Number of trucks", kind: "number", required: true },
      { key: "truck_types", label: "Truck types (tandem, tri-axle, tractor …)", kind: "text", required: true },
      { key: "trailer_count", label: "Number of trailers", kind: "number" },
      { key: "driver_count", label: "Number of drivers", kind: "number", required: true },
      { key: "dispatch_bases", label: "Dispatch bases (where trucks start from)", kind: "textarea", required: true },
    ],
  },
  {
    key: "systems", title: "Current systems and data",
    fields: [
      { key: "current_systems", label: "What you use today (dispatch, accounting, ELD, spreadsheets)", kind: "textarea", required: true },
      { key: "customer_data_ready", label: "Customer list ready to import?", kind: "choice", choices: ["Ready", "Needs cleanup", "Not started"], required: true },
      { key: "truck_data_ready", label: "Truck list ready to import?", kind: "choice", choices: ["Ready", "Needs cleanup", "Not started"], required: true },
      { key: "driver_data_ready", label: "Driver list ready to import?", kind: "choice", choices: ["Ready", "Needs cleanup", "Not started"], required: true },
    ],
  },
  {
    key: "dispatch", title: "Dispatch workflow",
    fields: [
      { key: "assignment_rules", label: "How loads are assigned today", kind: "textarea", required: true },
      { key: "availability", label: "How driver and truck availability is tracked", kind: "textarea" },
      { key: "maintenance_checks", label: "Maintenance and safety checks before dispatch", kind: "textarea" },
    ],
  },
  {
    key: "integrations", title: "Integrations and reports",
    fields: [
      { key: "required_integrations", label: "Systems Taviron must connect to", kind: "textarea", hint: "We confirm in the integration checklist what is available today." },
      { key: "required_reports", label: "Reports you rely on", kind: "textarea" },
    ],
  },
  {
    key: "launch", title: "Training and launch",
    fields: [
      { key: "training_needs", label: "Who needs training and how (on site, video, one-to-one)", kind: "textarea", required: true },
      { key: "critical_workflows", label: "Workflows that must work on day one", kind: "textarea", required: true },
      { key: "launch_window", label: "Preferred launch window", kind: "text", required: true },
      { key: "fallback", label: "Fallback if something fails on launch day", kind: "textarea", required: true, hint: "For example: paper tickets and phone dispatch for that day." },
    ],
  },
];

export function questionnaireMissing(data: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const s of QUESTIONNAIRE) for (const f of s.fields) {
    const v = data[f.key];
    if (f.required && (v === undefined || v === null || String(v).trim() === "")) missing.push(f.label);
  }
  return missing;
}

/** How a dispatch rule is applied. Only what the product actually does is called "Product-enforced". */
export type Enforcement = "enforced" | "manual" | "unsupported" | "untested";
export const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  enforced: "Product-enforced",
  manual: "Manually checked",
  unsupported: "Unsupported",
  untested: "Not yet tested",
};

export interface DispatchRule {
  key: string;
  title: string;
  /** What Taviron does today, with where it is enforced (verified in code and tests). */
  product: Enforcement;
  evidence: string;
  /** Where the company configures it in Taviron, when it can. */
  settingsHref?: string;
}

/** D. The worksheet's rules with the product's real behaviour (see docs/ONBOARDING.md §5 for the evidence). */
export const DISPATCH_RULES: DispatchRule[] = [
  { key: "bases", title: "Dispatch bases and operating hours", product: "enforced", evidence: "Trucks and drivers at another base are excluded unless the company allows cross-base dispatch (then proposed with a warning); per-person base access is enforced by row-level security. Operating hours are not checked by dispatch.", settingsHref: "/settings?tab=bases" },
  { key: "required_fields", title: "Work types and required order/load fields", product: "enforced", evidence: "An order needs a customer and cannot be confirmed without at least one line (checked by the database). Work types beyond Taviron's order lines are recorded here, not enforced." },
  { key: "eligibility", title: "Driver and truck eligibility (qualifications, truck type, capacity)", product: "enforced", evidence: "Smart Dispatch excludes a driver whose CDL or medical card is missing, expired, unverified or too low a class, a truck whose recorded capacity is below the load, and a tractor without a trailer." },
  { key: "preferences", title: "Assignment preferences and manual overrides", product: "manual", evidence: "Preferences (same job or site, capacity use, spreading loads) are scored but never override a hard rule; Smart Dispatch only proposes and a dispatcher approves every assignment or chooses another." },
  { key: "availability", title: "Driver availability and time off", product: "enforced", evidence: "Approved time off, deactivated drivers and overlapping bookings exclude a driver; pending time off and 'On leave' records are shown as warnings." },
  { key: "hos", title: "Hours of service", product: "manual", evidence: "No ELD integration: Taviron does not know hours of service. Dispatchers check them; Smart Dispatch never claims a driver is within limits." },
  { key: "maintenance", title: "Maintenance restrictions and trucks out of service", product: "enforced", evidence: "Out-of-service trucks, open safety-critical work orders and a shop visit on the load date exclude the truck; expired vehicle documents follow the company's fleet document policy." },
  { key: "safety", title: "Safety restrictions", product: "enforced", evidence: "An unresolved driver report of a breakdown or inspection problem, or an open safety-critical work order, excludes the truck until it is resolved." },
  { key: "exceptions", title: "Exception handling, escalation and after-hours coverage", product: "manual", evidence: "The Command Center and alerts show exceptions with acknowledgment and escalation; after-hours coverage is the company's own on-call plan." },
  { key: "customer_requirements", title: "Customer-specific requirements", product: "enforced", evidence: "Order requirements Taviron records (qualifications, capacity) are checked; free-text job instructions are read by the driver, not enforced." },
];

/** E. Integrations that exist in Taviron today, and the categories that do not (shown honestly). */
export interface IntegrationDef {
  key: string;
  name: string;
  purpose: string;
  systemOfRecord: string;
  available: boolean;
  /** Server configuration that must be present before it can be marked verified. */
  configKey?: "email" | "routing" | "ai" | "portal";
  fallback: string;
}
export const INTEGRATIONS: IntegrationDef[] = [
  { key: "auth", name: "Sign-in (Taviron accounts, two-step verification)", purpose: "Staff, driver and customer sign-in", systemOfRecord: "Taviron", available: true, fallback: "Administrators reissue sign-in sheets." },
  { key: "csv", name: "CSV import and export", purpose: "Initial customers, trucks, drivers, materials; billing hand-off export", systemOfRecord: "Taviron after approval", available: true, fallback: "Taviron imports from a corrected file." },
  { key: "email", name: "Email (quotes, setup links)", purpose: "Send quotes and sign-in setup links", systemOfRecord: "Email provider (Resend)", available: true, configKey: "email", fallback: "Print or copy; nothing is sent until email is configured." },
  { key: "routing", name: "Routing and maps (HERE)", purpose: "Route planning and drive times", systemOfRecord: "HERE", available: true, configKey: "routing", fallback: "Dispatchers plan routes manually." },
  { key: "portal", name: "Customer portal", purpose: "Customers follow orders and request quotes", systemOfRecord: "Taviron", available: true, configKey: "portal", fallback: "Customers call or email the office." },
  { key: "ai", name: "AI assistance", purpose: "Optional suggestions and drafts (always reviewed by a person)", systemOfRecord: "Taviron (AI provider processes requests)", available: true, configKey: "ai", fallback: "Everything works without AI." },
  { key: "accounting", name: "Accounting system", purpose: "Invoices and payments", systemOfRecord: "Your accounting system", available: false, fallback: "Billing hand-off CSV, entered in your accounting system." },
  { key: "eld", name: "ELD / telematics / hours of service", purpose: "Driver hours and truck locations", systemOfRecord: "Your ELD provider", available: false, fallback: "Hours of service checked manually; drivers confirm on My Day." },
  { key: "payments", name: "Payments", purpose: "Collect customer payments", systemOfRecord: "—", available: false, fallback: "Payments stay in your current process." },
];

export type CheckStatus = "not_started" | "configured" | "verified" | "failed" | "not_needed" | "unavailable";
export const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  not_started: "Not started",
  configured: "Configured, not verified",
  verified: "Verified",
  failed: "Failed",
  not_needed: "Not needed",
  unavailable: "Not available in Taviron",
};

/** F. Go-live acceptance items (same keys and critical flags as private.go_live_items()). */
export const GO_LIVE_ITEMS: Array<{ key: string; title: string; critical: boolean; evidenceHint: string }> = [
  { key: "commercial_scope", title: "Commercial scope and plan", critical: false, evidenceHint: "Plan, terms and go-live date agreed (lifecycle page)." },
  { key: "tenant_permissions", title: "Correct company and user permissions", critical: true, evidenceHint: "People and roles reviewed; nobody sees another company's data." },
  { key: "data_validation", title: "Data import validated and approved by the customer", critical: true, evidenceHint: "Import batches approved; counts checked by the customer." },
  { key: "dispatch_testing", title: "Dispatch rules and operational testing", critical: true, evidenceHint: "Worksheet scenarios run with expected results." },
  { key: "safety_procedures", title: "Safety, availability and maintenance procedures", critical: true, evidenceHint: "Out-of-service and safety restrictions tested on real trucks." },
  { key: "integrations", title: "Required integrations and fallbacks", critical: false, evidenceHint: "Integration checklist verified or fallback agreed." },
  { key: "core_workflows", title: "Core workflows and reports", critical: false, evidenceHint: "Quote → order → dispatch → ticket → billing run end to end." },
  { key: "training", title: "User training", critical: false, evidenceHint: "Each role trained; attendance noted." },
  { key: "support_escalation", title: "Support contacts and escalation", critical: false, evidenceHint: "Who calls whom, and when." },
  { key: "fallback", title: "Fallback and rollback procedure", critical: false, evidenceHint: "What happens if launch day fails." },
  { key: "open_defects", title: "Unresolved defects and accepted manual controls", critical: false, evidenceHint: "Listed in Testing; none critical open." },
  { key: "launch_plan", title: "Launch date, time zone and activation owner", critical: false, evidenceHint: "Who activates, when, in which time zone." },
];
export type GoLiveStatus = "not_started" | "in_progress" | "passed" | "failed" | "not_applicable" | "exception";
export const GO_LIVE_STATUS_LABEL: Record<GoLiveStatus, string> = {
  not_started: "Not started", in_progress: "In progress", passed: "Passed", failed: "Failed", not_applicable: "Not applicable", exception: "Accepted exception",
};

/** The same rules as private.go_live_blockers (shown before signing; the database decides). */
export function goLiveBlockers(items: Record<string, { status?: GoLiveStatus; note?: string }>, issues: Array<{ status?: string; critical?: boolean }>): string[] {
  const out: string[] = [];
  for (const i of GO_LIVE_ITEMS) {
    const s = items[i.key]?.status ?? "not_started";
    const note = (items[i.key]?.note ?? "").trim();
    if (i.critical && s !== "passed") out.push(`${i.title} must be Passed.`);
    else if (!i.critical && !["passed", "not_applicable", "exception"].includes(s)) out.push(`${i.title} is ${GO_LIVE_STATUS_LABEL[s].toLowerCase()}.`);
    else if ((s === "exception" || s === "not_applicable") && note.length < 5) out.push(`${i.title} needs a written reason.`);
  }
  if (issues.some((x) => (x.status ?? "open") !== "resolved" && x.critical)) out.push("An open critical issue in Testing must be resolved.");
  return out;
}

/** A. The welcome email: editable per company; placeholders are filled from the company's own records. */
export const WELCOME_PLACEHOLDERS = ["company_name", "primary_contact", "onboarding_contact", "kickoff", "support_contact"] as const;
export type WelcomeValues = Partial<Record<(typeof WELCOME_PLACEHOLDERS)[number], string>>;

export const DEFAULT_WELCOME_SUBJECT = "Welcome to Taviron, {{company_name}} — your onboarding plan";
export const DEFAULT_WELCOME_BODY = `Hello {{primary_contact}},

Welcome to Taviron. I'm {{onboarding_contact}}, and I'll guide {{company_name}} from setup to go-live.

How onboarding works
1. Kickoff: {{kickoff}}. We confirm goals, people and your launch window.
2. Setup questionnaire: in Taviron under Setup → Onboarding. It tells us about your company, fleet, people and dispatch.
3. Your data: download the customer, truck and driver templates there, fill them in from your current system, and upload them to the onboarding task. We check every row, show duplicates and errors, and nothing is created until you approve it.
4. Dispatch configuration: together we record your dispatch rules in the worksheet and run test scenarios. The worksheet shows which rules Taviron enforces and which stay manual checks.
5. Integrations: we verify each connection you need, or agree a manual fallback where one isn't available.
6. Testing and training: your team tries real workflows; we fix issues before launch.
7. Go-live acceptance: we review the acceptance checklist together, and your owner and Taviron sign it off.

Onboarding, setup, training and testing all happen before your agreed go-live. Your recurring subscription starts at your actual go-live, as set out in your signed agreement — not when onboarding starts or your data is imported.

Questions any time: {{support_contact}}.

Welcome aboard,
{{onboarding_contact}}`;

export function renderWelcome(template: string, values: WelcomeValues): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => {
    const v = values[k as keyof WelcomeValues];
    return v && v.trim() ? v.trim() : `[${k.replace(/_/g, " ")}]`;
  });
}

/** Keys a form must never contain (mirrors the database check). */
export const FORBIDDEN_KEYS = /^(password|passwd|secret|api_?key|token|card_?number|cvv|ssn|social_security)$/i;
export function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (FORBIDDEN_KEYS.test(k) ? [`${path}${k}`] : forbiddenKeys(v, `${path}${k}.`)));
  }
  return [];
}

/** The kit's sections, in order (each is its own URL). */
export const KIT_SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "welcome", label: "Welcome email" },
  { key: "questionnaire", label: "Setup questionnaire" },
  { key: "data", label: "Data import" },
  { key: "dispatch", label: "Dispatch worksheet" },
  { key: "integrations", label: "Integrations" },
  { key: "testing", label: "Testing" },
  { key: "golive", label: "Go-live acceptance" },
  { key: "after", label: "After launch" },
] as const;
export type KitSectionKey = (typeof KIT_SECTIONS)[number]["key"];

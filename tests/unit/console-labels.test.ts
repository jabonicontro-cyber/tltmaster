// Platform console (PC1): one label map for every action the database records, plain formatting of dates and
// verdicts, and the small rules behind the console's new pages (filters, search links, Testing Lab notes).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVITY_TEXT, activityHref, activityText, customersSub, demoScheduledSub } from "@/lib/platform/launchpad";
import { dayOrNone, leadEventDetail, leadEventText } from "@/lib/platform/leads";
import {
  auditHref, healthVerdict, parseAuditFilters, pipelineColumn, pipelineDates, replyMailto, searchHits, stageLabel, timelineText, weekCompare,
  type ConsoleSearch, type PipelineLead,
} from "@/lib/platform/console";
import { LAB_VIEWS, demoPlanLabel, labDestination, viewUpdateNote } from "@/lib/platform/testing-lab";

const MIGRATIONS = join(__dirname, "../../supabase/migrations");
const sql = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, ""));

/** Every action key the migrations write to the platform audit log. */
function platformAuditActions(): Set<string> {
  const out = new Set<string>();
  for (const s of sql) {
    for (const m of s.matchAll(/platform_log\(\s*'([a-z0-9_.]+)'\s*[,|]/g)) out.add(m[1]);
    // Computed keys: case when … then 'a' else 'b' end.
    for (const m of s.matchAll(/platform_log\(\s*case\b([\s\S]*?)\bend\b/g)) for (const k of m[1].matchAll(/\b(?:then|else)\s+'([a-z0-9_.]+)'/g)) out.add(k[1]);
    // 'onboarding_fee_' || p_status, where the function accepts only paid and waived (20261118000300).
    if (/platform_log\('onboarding_fee_' \|\| p_status/.test(s)) { out.add("onboarding_fee_paid"); out.add("onboarding_fee_waived"); }
    // The operator's direct inserts (platform_admin_grant / revoke, scheduled go-lives).
    for (const m of s.matchAll(/insert into private\.platform_audit \([^)]*\)\s*values \(\s*[^,]+,\s*'([a-z0-9_.]+)'/g)) out.add(m[1]);
  }
  out.delete("onboarding_fee_");
  return out;
}

/** The lead history actions allowed by the latest lead_events check. */
function leadEventActions(): string[] {
  const defs = sql.flatMap((s) => [...s.matchAll(/lead_events_action_check check \(action in \(([^)]*)\)\)/g)].map((m) => m[1]));
  return [...defs[defs.length - 1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("activity labels", () => {
  it("has a plain label for every action a migration writes to the platform audit log", () => {
    const actions = platformAuditActions();
    expect(actions.size).toBeGreaterThan(40);
    const missing = [...actions].filter((a) => !ACTIVITY_TEXT[a]);
    expect(missing, `Add these to ACTIVITY_TEXT in src/lib/platform/launchpad.ts: ${missing.join(", ")}`).toEqual([]);
    for (const a of ["support_entered", "onboarding.generate", "testing_lab.check", "company_archived", "demo_plan_set", "go_live_signed", "support_request", "onboarding.status"]) expect(actions.has(a), a).toBe(true);
  });
  it("has a label for every lead history action, in the activity feed and on the lead page", () => {
    const actions = leadEventActions();
    expect(actions).toContain("demo_date_changed");
    for (const a of actions) {
      expect(ACTIVITY_TEXT[a], a).toBeTruthy();
      expect(leadEventText(a), a).not.toBe(a);
    }
  });
  it("never shows a raw key: an unknown action still reads as words", () => {
    expect(activityText({ source: "platform", action: "support_entered" })).toBe("Went into a company as support");
    expect(activityText("onboarding.generate")).toBe("Onboarding checklist updated");
    expect(activityText("some.new_thing")).toBe("Some new thing");
    expect(activityText({ source: "lead", action: "company_created" })).toBe("Company created from a lead");
    expect(activityText("")).toBe("Something changed");
  });
  it("links acknowledged items and support requests to their record", () => {
    expect(activityHref({ ref_type: "lead_overdue", ref_id: "x" })).toBe("/admin/leads/x");
    expect(activityHref({ ref_type: "import_review", ref_id: "b" })).toBe("/admin/onboarding/batch/b");
    expect(activityHref({ ref_type: "support_request", ref_id: "r" })).toBe("/admin/support/r");
    expect(activityHref({ ref_type: "company", ref_id: "" })).toBeNull();
  });
});

describe("lead history formatting", () => {
  it("shows days as people read them, never raw ISO dates", () => {
    expect(dayOrNone("2026-11-14")).toBe("Nov 14, 2026");
    expect(dayOrNone(null)).toBe("none");
    expect(leadEventDetail({ action: "follow_up_changed", detail: { from: null, to: "2026-11-14" } }, new Map())).toBe("none → Nov 14, 2026");
    expect(leadEventDetail({ action: "demo_date_changed", detail: { from: "2026-11-14", to: null } }, new Map())).toBe("Nov 14, 2026 → none");
    expect(leadEventDetail({ action: "status_changed", detail: { from: "new", to: "demo_scheduled" } }, new Map())).toBe("New → Demo Scheduled");
    expect(leadEventDetail({ action: "owner_changed", detail: { from: null, to: "u1" } }, new Map([["u1", "Pia"]]))).toBe("nobody → Pia");
  });
});

describe("company health verdict", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const base = { active: true, members: 3, last_sign_in_at: null as string | null, last_activity_at: null as string | null, is_demo: false };
  it("says plainly how the company is doing", () => {
    expect(healthVerdict({ ...base, active: false }, now).label).toBe("Inactive");
    expect(healthVerdict({ ...base, members: 0 }, now).label).toBe("No one can sign in yet");
    expect(healthVerdict(base, now).label).toBe("Not signed in yet");
    expect(healthVerdict({ ...base, last_sign_in_at: "2026-11-12T08:00:00Z" }, now).label).toBe("Active today");
    expect(healthVerdict({ ...base, last_activity_at: "2026-11-08T08:00:00Z" }, now)).toMatchObject({ label: "Active this week", tone: "green" });
    // The later of sign-in and activity counts.
    expect(healthVerdict({ ...base, last_sign_in_at: "2026-10-01T08:00:00Z", last_activity_at: "2026-10-31T08:00:00Z" }, now)).toMatchObject({ label: "Quiet for 12 days", tone: "amber" });
    expect(healthVerdict({ ...base, last_sign_in_at: "2026-09-01T08:00:00Z" }, now).tone).toBe("critical-soft");
  });
  it("compares weeks in words", () => {
    expect(weekCompare(0, 0)).toBe("None this week or last week");
    expect(weekCompare(5, 3)).toBe("5 this week · up from 3 last week");
    expect(weekCompare(2, 4)).toBe("2 this week · down from 4 last week");
    expect(weekCompare(4, 4)).toBe("4 this week · same as 4 last week");
  });
  it("names every stage, including companies with no subscription record", () => {
    expect(stageLabel("not_set_up")).toBe("Subscription not set up");
    expect(stageLabel("fee_due")).toBe("Onboarding fee due");
    expect(stageLabel(null)).toBe("Not known");
  });
});

describe("customer timeline wording", () => {
  const item = { at: "2026-11-12T00:00:00Z", detail: {}, note: "", actor: "Pia" };
  it("words each source", () => {
    expect(timelineText({ ...item, source: "platform", kind: "lifecycle_terms_set", summary: "Essential v1" })).toEqual({ title: "Subscription terms set", detail: "Essential v1" });
    expect(timelineText({ ...item, source: "support", kind: "visit_started", summary: "Fix a rate" }).detail).toBe("Helping with: Fix a rate");
    expect(timelineText({ ...item, source: "support", kind: "visit_ended", summary: "access_ended" }).detail).toBe("Ended: the owner ended access");
    expect(timelineText({ ...item, source: "onboarding", kind: "status", summary: "Send your customer list", detail: { from: "submitted", to: "approved", internal: false } }).detail).toBe("Send your customer list · Submitted for review → Approved");
    expect(timelineText({ ...item, source: "subscription", kind: "tier_change_scheduled", summary: "2026-12" }).title).toBe("Plan change scheduled");
    expect(timelineText({ ...item, source: "lead", kind: "demo_date_changed", summary: "Dana", detail: { from: null, to: "2026-11-20" } }).detail).toBe("Lead Dana · none → Nov 20, 2026");
  });
});

describe("audit filters and paging", () => {
  it("keeps well-formed filters only", () => {
    const f = parseAuditFilters({ actor: "6dec37d7-082f-47e2-99c6-772e692badae", action: "support_entered", company: "nope", from: "2026-11-01", to: "11/12/2026", before: "123; drop" });
    expect(f).toEqual({ actor: "6dec37d7-082f-47e2-99c6-772e692badae", action: "support_entered", company: "", from: "2026-11-01", to: "", before: "" });
    expect(parseAuditFilters({ action: "Robert'); --" }).action).toBe("");
  });
  it("builds the address of the same filters on another page", () => {
    const f = parseAuditFilters({ action: "staff_joined", from: "2026-11-01" });
    expect(auditHref(f)).toBe("/admin/platform?action=staff_joined&from=2026-11-01#audit");
    expect(auditHref(f, "99")).toBe("/admin/platform?action=staff_joined&from=2026-11-01&before=99#audit");
    expect(auditHref(parseAuditFilters({}))).toBe("/admin/platform#audit");
  });
});

describe("console search links", () => {
  const r: ConsoleSearch = {
    companies: [{ id: "c1", name: "Top Line Trucking", is_demo: false, active: true, stage: "live" }, { id: "c2", name: "Northfield (Demo)", is_demo: true, active: true, stage: "demo" }],
    requests: [{ id: "r1", company: "Top Line Trucking", status: "new", message: "Where is my ticket?", created_at: "2026-11-12T00:00:00Z" }],
    leads: [{ id: "l1", name: "Dana", company_name: "Dana Haul", status: "new", disposition: "", created_at: "2026-11-12T00:00:00Z" }],
    prospects: [], team: [],
  };
  it("sends Admins to the record and Support staff to the company desk and their inbox", () => {
    const admin = searchHits(r, "admin");
    expect(admin.find((h) => h.title === "Top Line Trucking")?.href).toBe("/admin/companies/c1");
    expect(admin.find((h) => h.title === "Northfield (Demo)")?.href).toBe("/staff?q=Northfield%20(Demo)");
    expect(admin.find((h) => h.group === "Support requests")?.href).toBe("/admin/support/r1");
    const support = searchHits({ ...r, leads: [] }, "support");
    expect(support.find((h) => h.title === "Top Line Trucking")?.href).toBe("/staff?q=Top%20Line%20Trucking");
    expect(support.find((h) => h.group === "Support requests")?.href).toBe("/staff/support/r1");
  });
  it("opens a reply in the staff member's own email, encoded", () => {
    expect(replyMailto("a+b@x.example", "Top Line", "Hi & thanks")).toBe("mailto:a%2Bb%40x.example?subject=Your%20Taviron%20support%20request%20(Top%20Line)&body=Hi%20%26%20thanks");
  });
});

describe("lead pipeline", () => {
  const lead = (p: Partial<PipelineLead>): PipelineLead => ({ id: "x", kind: "demo", status: "demo_scheduled", name: "N", company_name: "", truck_count: null, owner_name: null, follow_up_on: null, demo_on: null, onboarding_stage: "", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...p });
  it("puts the soonest demo first and words dates", () => {
    const col = pipelineColumn([lead({ id: "a" }), lead({ id: "b", demo_on: "2026-11-20" }), lead({ id: "c", demo_on: "2026-11-14" }), lead({ id: "d", status: "new" })], "demo_scheduled");
    expect(col.map((l) => l.id)).toEqual(["c", "b", "a"]);
    expect(pipelineDates(lead({ demo_on: "2026-11-14", follow_up_on: "2026-11-10" }), "2026-11-12")).toEqual([
      { text: "Demo Nov 14, 2026", tone: "blue" },
      { text: "Follow-up overdue since Nov 10, 2026", tone: "critical-soft" },
    ]);
    expect(pipelineDates(lead({ status: "converted", follow_up_on: "2026-11-10" }), "2026-11-12")).toEqual([]);
  });
});

describe("Launchpad lines", () => {
  it("counts demo dates and companies without a subscription record", () => {
    const leads = { by_status: {}, new: 0, overdue: 0, due_today: 0, demo_scheduled: 2, onboarding: 0 };
    expect(demoScheduledSub(leads, (d) => d)).toBe("Leads in Demo Scheduled");
    expect(demoScheduledSub({ ...leads, demo_dated: 0 }, (d) => d)).toBe("No demo date booked yet: add one on the lead");
    expect(demoScheduledSub({ ...leads, demo_dated: 2, next_demo_on: "2026-11-14" }, (d) => `on ${d}`)).toBe("2 with a demo date · next on 2026-11-14");
    expect(customersSub({ live: 0, total: 3, not_set_up: 2 })).toBe("live · 3 active in all · 2 subscription not set up");
    expect(customersSub({ live: 1, total: 1 })).toBe("live · 1 active in all");
  });
});

describe("Testing Lab", () => {
  it("only mentions database updates while the Testing Lab's own update is missing, in plain words", () => {
    const v = LAB_VIEWS.find((x) => x.migration)!;
    expect(viewUpdateNote(v, true)).toBeNull();
    expect(viewUpdateNote(v, false)).not.toMatch(/\d{8}/);
    for (const view of LAB_VIEWS) expect(`${view.what} ${view.note ?? ""}`).not.toMatch(/master plan|B\d{2}|docs\//);
  });
  it("shows the demo's effective plan and opens the onboarding checklist", () => {
    expect(demoPlanLabel(null)).toBe("Essential");
    expect(demoPlanLabel("growth")).toBe("Growth");
    const onboarding = LAB_VIEWS.find((x) => x.key === "onboarding.portal")!;
    expect(onboarding.implementation).toBe("available");
    expect(onboarding.open).toEqual({ kind: "role", role: "owner", to: "setup" });
    expect(labDestination("setup")).toBe("/setup");
    expect(labDestination("evil")).toBeNull();
  });
});

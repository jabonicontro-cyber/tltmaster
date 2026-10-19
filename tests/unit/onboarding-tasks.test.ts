import { describe, expect, it } from "vitest";
import { checkOnboardingFile, customerActions, customerOrder, isOverdue, staffActions, statusLabel, type OnboardingTask } from "@/lib/onboarding/tasks";

const task = (over: Partial<OnboardingTask>): OnboardingTask => ({
  id: "t", key: "k", title: "T", instructions: "", category: "data", side: "customer", review_required: true, required: true,
  readiness_id: null, import_entity: null, depends_on: [], unmet: [], status: "not_started", status_note: "", assignee: null,
  assignee_name: null, due_on: null, submitted_at: null, decided_at: null, last_reminded_at: null, updated_at: "", documents: [], events: [],
  ...over,
});
const statuses = (a: Array<{ status: string }>) => a.map((x) => x.status);

describe("onboarding status rules (mirror private.onboarding_change)", () => {
  it("the company submits a reviewed task and never approves it", () => {
    expect(statuses(customerActions(task({})))).toEqual(["submitted", "in_progress", "blocked"]);
    expect(statuses(customerActions(task({}))).includes("approved")).toBe(false);
    expect(customerActions(task({ status: "changes_requested" }))[0].label).toBe("Resubmit for review");
  });
  it("the company completes a task without review itself", () => {
    expect(statuses(customerActions(task({ review_required: false })))).toContain("approved");
  });
  it("offers nothing on Taviron's tasks or finished tasks, and only withdraw while submitted", () => {
    expect(customerActions(task({ side: "taviron" }))).toEqual([]);
    expect(customerActions(task({ status: "approved" }))).toEqual([]);
    expect(customerActions(task({ status: "not_applicable" }))).toEqual([]);
    expect(statuses(customerActions(task({ status: "submitted" })))).toEqual(["in_progress"]);
  });
  it("waits for dependencies before submitting or approving", () => {
    expect(statuses(customerActions(task({ unmet: ["Trucks"] })))).not.toContain("submitted");
    expect(statuses(staffActions(task({ unmet: ["Trucks"] })))).not.toContain("approved");
  });
  it("Taviron approves, requests changes (with a reason) and reopens", () => {
    const s = staffActions(task({ status: "submitted" }));
    expect(statuses(s)).toEqual(expect.arrayContaining(["approved", "changes_requested", "blocked", "not_applicable"]));
    expect(s.find((a) => a.status === "changes_requested")!.needsNote).toBe(true);
    expect(staffActions(task({ status: "approved" })).map((a) => a.label)).toContain("Reopen");
    expect(staffActions(task({ required: false })).find((a) => a.status === "not_applicable")!.needsNote).toBe(false);
  });
  it("labels and order", () => {
    expect(statusLabel("approved", false)).toBe("Completed");
    expect(statusLabel("submitted")).toBe("Submitted for review");
    const ordered = customerOrder([task({ key: "a", status: "approved" }), task({ key: "b", status: "changes_requested" }), task({ key: "c", side: "taviron" })]);
    expect(ordered.map((t) => t.key)).toEqual(["b", "c", "a"]);
    expect(isOverdue(task({ due_on: "2026-01-01" }), "2026-02-01")).toBe(true);
    expect(isOverdue(task({ due_on: "2026-01-01", status: "approved" }), "2026-02-01")).toBe(false);
  });
});

describe("onboarding files", () => {
  const bytes = (s: string | number[]) => (typeof s === "string" ? new TextEncoder().encode(s) : new Uint8Array(s));
  it("detects the real type from content, not the name", () => {
    expect(checkOnboardingFile(bytes("%PDF-1.7 ..."), "x.csv")).toEqual({ ok: true, type: "application/pdf" });
    expect(checkOnboardingFile(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "a.png")).toEqual({ ok: true, type: "image/png" });
    expect(checkOnboardingFile(bytes("name,email\nA,b@c.d\n"), "customers.csv")).toEqual({ ok: true, type: "text/csv" });
  });
  it("refuses executables, binary CSVs, other names and empty or large files", () => {
    expect(checkOnboardingFile(bytes([0x4d, 0x5a, 0x90, 0]), "a.exe").ok).toBe(false);
    expect(checkOnboardingFile(bytes([0x61, 0, 0x62]), "a.csv").ok).toBe(false);
    expect(checkOnboardingFile(bytes([0xff, 0xfe, 0x00]), "a.csv").ok).toBe(false);
    expect(checkOnboardingFile(bytes("name\n"), "a.txt").ok).toBe(false);
    expect(checkOnboardingFile(new Uint8Array(0), "a.csv").ok).toBe(false);
    expect(checkOnboardingFile(new Uint8Array(10 * 1024 * 1024 + 1), "a.pdf")).toMatchObject({ ok: false, status: 413 });
  });
});

import { describe, expect, it } from "vitest";
import { appendFindings, finishesJob, finishTarget, mechanicNextStep, shortStock, type MechanicJobState } from "@/lib/maintenance";

// The next step on a mechanic's job card (UX14; first-day review 2026-11-09): plain words that follow the real state
// and match the buttons the card shows.
describe("mechanic next step", () => {
  const job = (status: string, tasksDone = 0, tasksTotal = 0, more: Partial<MechanicJobState> = {}): MechanicJobState => ({ status, tasksDone, tasksTotal, ...more });
  it("says to start a job that has not started, and that the timer starts with it", () => {
    for (const s of ["reported", "triaged", "scheduled"]) expect(mechanicNextStep(job(s), "none")).toBe("Next: tap Start this job when you begin work. Your timer starts with it.");
  });
  it("says a job is waiting for parts, naming the part when known", () => {
    expect(mechanicNextStep(job("awaiting_parts"), "none")).toBe("Waiting for parts. Start the job again when they are in.");
    expect(mechanicNextStep(job("awaiting_parts", 0, 0, { missingPart: " Rear brake chamber " }), "none")).toBe("Waiting for parts: Rear brake chamber. Start the job again when it is in.");
  });
  it("says a job waits for an authorized inspection", () => {
    expect(mechanicNextStep(job("awaiting_inspection", 4, 4, { finisher: true }), "none")).toMatch(/^Waiting for an authorized inspection/);
  });
  it("follows the timer and the checklist on a job in progress", () => {
    expect(mechanicNextStep(job("in_progress", 1, 3), "none")).toBe("Next: start your timer and work through the checklist (2 left).");
    expect(mechanicNextStep(job("in_progress", 1, 3), "here")).toBe("Your timer is running. Work through the checklist (2 left). Stop the timer when you take a break.");
    expect(mechanicNextStep(job("in_progress", 3, 3, { finisher: true }), "here")).toBe("Your timer is running. When the repair is done, tap Finish the job and say what you fixed.");
    expect(mechanicNextStep(job("in_progress"), "elsewhere")).toMatch(/on another job/);
  });
  it("checklist complete and timer stopped: the lead finishes the job, never 'start your timer'", () => {
    expect(mechanicNextStep(job("in_progress", 4, 4, { finisher: true }), "none")).toBe("Finish the job: say what you fixed.");
    expect(mechanicNextStep(job("in_progress", 4, 4, { finisher: true, safetyCritical: true }), "none")).toBe("Finish the job: say what you fixed. It then waits for an authorized inspection.");
    expect(mechanicNextStep(job("in_progress", 4, 4, { finisher: true }), "none")).not.toMatch(/start your timer/i);
    // A lead whose own part was already marked done still sees the step that is theirs.
    expect(mechanicNextStep(job("in_progress", 4, 4, { finisher: true, myStatus: "done" }), "none")).toBe("Finish the job: say what you fixed.");
  });
  it("a helper is told who finishes the job", () => {
    expect(mechanicNextStep(job("in_progress", 2, 2, { leadName: "Sam Ortiz" }), "none")).toBe("Checklist done. Tap My part is done; Sam Ortiz finishes the job.");
    expect(mechanicNextStep(job("in_progress", 2, 2), "none")).toBe("Checklist done. Tap My part is done; the lead mechanic finishes the job.");
    expect(mechanicNextStep(job("in_progress", 2, 2, { myStatus: "done", leadName: "Sam Ortiz" }), "none")).toBe("Your part is done. Sam Ortiz finishes the job.");
  });
  it("a job without a checklist still ends with saying what was fixed", () => {
    expect(mechanicNextStep(job("in_progress", 0, 0, { finisher: true }), "none")).toMatch(/finish the job: say what you fixed\.$/);
    expect(mechanicNextStep(job("in_progress", 0, 0), "none")).toMatch(/tap My part is done; the lead mechanic finishes the job\.$/);
  });
});

describe("finishing a job", () => {
  it("the lead, or the only mechanic, finishes the job; anyone does when there is no lead", () => {
    expect(finishesJob("lead", 3)).toBe(true);
    expect(finishesJob("assist", 1)).toBe(true);
    expect(finishesJob("assist", 2)).toBe(false);
    // A crew without a lead: anyone on it may finish, so the job never waits on nobody.
    expect(finishesJob("assist", 2, false)).toBe(true);
  });
  it("a safety-critical job always goes to an authorized inspection, never straight to completed", () => {
    expect(finishTarget(true)).toBe("awaiting_inspection");
    expect(finishTarget(false)).toBe("completed");
  });
  it("adds what was fixed to the findings, once", () => {
    expect(appendFindings("", "Replaced chamber")).toBe("Replaced chamber");
    expect(appendFindings(null, "  Replaced chamber ")).toBe("Replaced chamber");
    expect(appendFindings("Air leak found", "Replaced chamber")).toBe("Air leak found\nReplaced chamber");
    expect(appendFindings("Air leak found\nReplaced chamber", "Replaced chamber")).toBeNull();
    expect(appendFindings("x", "  ")).toBeNull();
    expect(appendFindings("a".repeat(3999), "bbb")!.length).toBe(4000);
  });
});

describe("short stock", () => {
  it("reads the database's 'Only N unit on hand.' message", () => {
    expect(shortStock("Only 2 kit on hand.")).toEqual({ onHand: 2, unit: "kit" });
    expect(shortStock("Only 1.5 gal on hand.")).toEqual({ onHand: 1.5, unit: "gal" });
    expect(shortStock("Choose a part.")).toBeNull();
    expect(shortStock(null)).toBeNull();
  });
});

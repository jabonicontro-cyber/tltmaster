import { describe, expect, it } from "vitest";
import { mechanicNextStep } from "@/lib/maintenance";

// The next step on a mechanic's job card (UX14): plain words that match the buttons the card shows.
describe("mechanic next step", () => {
  const job = (status: string, tasksDone = 0, tasksTotal = 0) => ({ status, tasksDone, tasksTotal });
  it("says to start a job that has not started", () => {
    for (const s of ["reported", "triaged", "scheduled"]) expect(mechanicNextStep(job(s), "none")).toMatch(/^Next: tap Start this job/);
  });
  it("says a job is waiting for parts", () => {
    expect(mechanicNextStep(job("awaiting_parts"), "none")).toMatch(/^Waiting for parts/);
  });
  it("follows the timer and the checklist on a job in progress", () => {
    expect(mechanicNextStep(job("in_progress", 1, 3), "none")).toBe("Next: start your timer while you work. Work through the checklist (2 left). When your part is finished, tap My part is done.");
    expect(mechanicNextStep(job("in_progress", 3, 3), "here")).toBe("Your timer is running. Stop the timer when you take a break or finish.");
    expect(mechanicNextStep(job("in_progress"), "elsewhere")).toMatch(/on another job/);
  });
});

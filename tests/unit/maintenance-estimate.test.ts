import { describe, expect, it } from "vitest";
import { jobWords, learnedEstimate, MIN_JOBS, performanceBy, summarize, type CompletedJob } from "@/lib/maintenance-estimate";

// B91: estimates learned from the company's own completed jobs — median, a minimum sample, outliers left out, the most
// specific comparable jobs first, and estimate against actual per kind of job and per mechanic.

const job = (id: string, hours: number, o: Partial<CompletedJob> = {}): CompletedJob => ({
  id, hours, category: "brakes", equipment: "tri_axle_dump", title: "Replace brake shoes", estimated: null, lead: null, completedAt: "2026-10-01", ...o,
});

describe("summarize", () => {
  it("needs the minimum number of jobs", () => {
    expect(MIN_JOBS).toBe(3);
    expect(summarize([2, 3])).toBeNull();
    expect(summarize([2, 3, 4])).toEqual({ hours: 3, low: 2.5, high: 3.5, jobs: 3, outliers: 0 });
  });
  it("leaves out outliers and ignores impossible values", () => {
    const s = summarize([3, 3.2, 3.4, 3.6, 40, 0, Number.NaN]);
    expect(s).toMatchObject({ jobs: 4, outliers: 1 });
    expect(s!.hours).toBe(3.3);
  });
});

describe("learnedEstimate", () => {
  it("prefers the same kind of job, then category and equipment, then category", () => {
    const history = [job("a", 2), job("b", 2.2), job("c", 2.4), job("d", 9, { title: "Brake drum resurface" }), job("e", 8, { equipment: "tractor", title: "Air dryer" })];
    expect(learnedEstimate({ category: "brakes", equipment: "tri_axle_dump", title: "Replace rear brake shoes" }, history)).toMatchObject({ match: "same job", hours: 2.2, jobs: 3 });
    expect(learnedEstimate({ category: "brakes", equipment: "tri_axle_dump", title: "Slack adjuster" }, history)).toMatchObject({ match: "same category and equipment", jobs: 3, outliers: 1 });
    expect(learnedEstimate({ category: "brakes", equipment: "end_dump_trailer", title: "Slack adjuster" }, history)).toMatchObject({ match: "same category", jobs: 5 });
    expect(learnedEstimate({ category: "tires", equipment: null, title: "Flat" }, history)).toBeNull();
  });
  it("never counts the job itself", () => {
    const history = [job("a", 2), job("b", 2.2), job("self", 2.4)];
    expect(learnedEstimate({ id: "self", category: "brakes", equipment: "tri_axle_dump", title: "Replace brake shoes" }, history)).toBeNull();
  });
  it("finds job words", () => {
    expect([...jobWords("Replace worn steer tires (x2)")]).toEqual(["replace", "worn", "steer", "tires"]);
  });
});

describe("performanceBy", () => {
  it("compares actual with estimate, only where an estimate was recorded", () => {
    const jobs = [job("a", 3, { estimated: 2, lead: "Pia" }), job("b", 1, { estimated: 2, lead: "Pia" }), job("c", 5, { estimated: 4, lead: "Max" }), job("d", 7, { lead: "Max" })];
    expect(performanceBy(jobs, (j) => j.lead)).toEqual([
      { key: "Pia", jobs: 2, actual: 4, estimated: 4, variance: 0 },
      { key: "Max", jobs: 1, actual: 5, estimated: 4, variance: 0.25 },
    ]);
  });
});

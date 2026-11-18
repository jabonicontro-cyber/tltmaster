// A shop job scheduled before its ordered part arrives (owner decision 2026-11-16/17, WK3): a warning and a move offer
// to the arrival day, never a move on its own.
import { describe, expect, it } from "vitest";
import { moveLabel, partArrivalConflict, partArrivalConflicts, partArrivalText } from "@/lib/maintenance/part-arrival";

const today = "2026-11-18";
const job = (over: Partial<{ id: string; status: string; scheduled_for: string | null }> = {}) => ({ id: "wo1", status: "scheduled", scheduled_for: "2026-11-20", ...over });
const part = (over: Partial<{ work_order_id: string; description: string; expected_on: string | null; status: string }> = {}) => ({ work_order_id: "wo1", description: "Wiper motor", expected_on: "2026-11-23", status: "waiting", ...over });

describe("partArrivalConflict", () => {
  it("warns and offers the arrival day when a part is expected after the scheduled day", () => {
    const c = partArrivalConflict(job(), [part()], today)!;
    expect(c).toEqual({ workOrderId: "wo1", scheduledFor: "2026-11-20", arrivesOn: "2026-11-23", parts: ["Wiper motor"], moveTo: "2026-11-23" });
    expect(partArrivalText(c)).toBe("Scheduled Nov 20, 2026, but Wiper motor is expected Nov 23, 2026.");
    expect(moveLabel(c)).toBe("Move to Nov 23, 2026");
  });

  it("uses the last part expected, and names how many", () => {
    const c = partArrivalConflict(job(), [part(), part({ description: "Wiper arm", expected_on: "2026-11-25" }), part({ description: "Fuse", expected_on: "2026-11-19" })], today)!;
    expect(c.arrivesOn).toBe("2026-11-25");
    expect(c.parts).toEqual(["Wiper motor", "Wiper arm"]);
    expect(partArrivalText(c)).toBe("Scheduled Nov 20, 2026, but 2 parts are expected Nov 25, 2026.");
  });

  it("is quiet when the part arrives in time, was received or canceled, or the job is not waiting on a date", () => {
    expect(partArrivalConflict(job(), [part({ expected_on: "2026-11-20" })], today)).toBeNull();
    expect(partArrivalConflict(job(), [part({ status: "received" }), part({ status: "canceled" })], today)).toBeNull();
    expect(partArrivalConflict(job({ scheduled_for: null }), [part()], today)).toBeNull();
    expect(partArrivalConflict(job({ status: "in_progress" }), [part()], today)).toBeNull();
    expect(partArrivalConflict(job(), [part({ work_order_id: "other" })], today)).toBeNull();
  });

  it("only warns, with no move offer, when a part has no expected date", () => {
    const c = partArrivalConflict(job({ status: "awaiting_parts" }), [part({ expected_on: null })], today)!;
    expect(c.moveTo).toBeNull();
    expect(moveLabel(c)).toBeNull();
    expect(partArrivalText(c)).toBe("Scheduled Nov 20, 2026, but Wiper motor on order has no expected date yet. Check it arrives in time.");
  });

  it("never offers a past day: a late part is offered today", () => {
    const c = partArrivalConflict(job({ scheduled_for: "2026-11-15" }), [part({ expected_on: "2026-11-17" })], today)!;
    expect(c.moveTo).toBe(today);
  });

  it("collects the conflicts of a list by work order", () => {
    const m = partArrivalConflicts([job(), job({ id: "wo2" })], [part(), part({ work_order_id: "wo2", expected_on: "2026-11-19" })], today);
    expect([...m.keys()]).toEqual(["wo1"]);
  });
});

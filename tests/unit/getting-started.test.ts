import { describe, expect, it } from "vitest";
import { CHECKLIST_PLACE, checklistRole, checklistStorageKey, gettingStartedItems, itemDone, showChecklist } from "@/lib/getting-started";
import type { Permission } from "@/lib/permissions";

// "Getting started": each role's first real steps, ticked from recorded data, only with the permission to do them.

const all = () => true;
const only = (...p: Permission[]) => (x: Permission) => p.includes(x);

describe("getting started items", () => {
  it("owner: company phone first (with the call-us wording), then truck, a person, a customer and an order", () => {
    const items = gettingStartedItems("owner", { companyPhone: false, companyLogo: false, trucks: true, teamInvited: false, customers: true, orders: false }, all);
    expect(items.map((i) => i.key)).toEqual(["phone", "truck", "person", "customer", "order"]);
    expect(items[0]).toMatchObject({ label: "Add your company phone so drivers and customers can call you", href: "/settings?tab=company#phone", done: false });
    expect(items[0].hint).toMatch(/logo/);
    expect(items.map((i) => i.done)).toEqual([false, true, false, true, false]);
  });

  it("owner with a phone and a logo: the phone step is ticked and no logo hint", () => {
    const [phone] = gettingStartedItems("owner", { companyPhone: true, companyLogo: true }, all);
    expect(phone).toMatchObject({ done: true, hint: undefined });
  });

  it("a fact that could not be read is never claimed as done: the step becomes a plain link", () => {
    const [phone] = gettingStartedItems("owner", { companyPhone: null }, all);
    expect(phone.done).toBeNull();
  });

  it("leaves out steps the person has no permission for", () => {
    const office = gettingStartedItems("office", { myOrder: true, myTicketReview: false, myInvoice: false, customers: true }, only("orders.edit", "tickets.review"));
    expect(office.map((i) => i.key)).toEqual(["order", "ticket"]);
  });

  it("every role has 3 to 5 steps with its usual permissions", () => {
    expect(gettingStartedItems("office", {}, all)).toHaveLength(4);
    expect(gettingStartedItems("dispatcher", {}, all).map((i) => i.key)).toEqual(["plan", "assign", "message"]);
    expect(gettingStartedItems("driver", {}, all).map((i) => i.key)).toEqual(["pretrip", "load", "ticket"]);
    expect(gettingStartedItems("mechanic", {}, all).map((i) => i.key)).toEqual(["job", "start", "stop"]);
  });

  it("driver: today's load links to today's loads; without one it says when it appears", () => {
    const withLoad = gettingStartedItems("driver", { todayLoadAnchor: "today-loads" }, all).find((i) => i.key === "load")!;
    expect(withLoad).toMatchObject({ href: "/driver#today-loads", hint: undefined, done: null });
    expect(gettingStartedItems("driver", {}, all).find((i) => i.key === "load")!.hint).toMatch(/as soon as dispatch assigns/);
  });
});

describe("when the card shows", () => {
  const items = gettingStartedItems("dispatcher", { myAssignment: true }, all);

  it("shows while a step is left; a step nothing records ticks once opened on this device", () => {
    expect(showChecklist(items, { dismissed: false, presentation: false })).toBe(true);
    expect(itemDone(items[0], [])).toBe(false);
    expect(itemDone(items[0], ["plan"])).toBe(true);
    expect(showChecklist(items, { dismissed: false, presentation: false, opened: ["plan", "message"] })).toBe(false);
  });

  it("never in presentation mode, once put away, or with fewer than two steps", () => {
    expect(showChecklist(items, { dismissed: true, presentation: false })).toBe(false);
    expect(showChecklist(items, { dismissed: false, presentation: true })).toBe(false);
    expect(showChecklist(items.slice(0, 1), { dismissed: false, presentation: false })).toBe(false);
  });

  it("a recorded step cannot be ticked by opening it", () => {
    const office = gettingStartedItems("office", { myOrder: false }, all);
    expect(itemDone(office[0], ["order"])).toBe(false);
  });
});

describe("roles and places", () => {
  it("each role's checklist lives on its landing page; an accountant has none", () => {
    expect(CHECKLIST_PLACE).toEqual({ owner: "command-center", office: "command-center", dispatcher: "command-center", driver: "my-day", mechanic: "my-jobs" });
    expect(checklistRole("accountant")).toBeNull();
    expect(checklistRole(null)).toBeNull();
    expect(checklistRole("driver")).toBe("driver");
  });

  it("remembers per person and per company", () => {
    expect(checklistStorageKey("c1", "u1")).toBe("taviron-getting-started:c1:u1");
  });
});

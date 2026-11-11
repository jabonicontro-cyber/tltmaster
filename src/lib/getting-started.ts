// "Getting started": a short checklist of a person's first real actions in their role, on the page they land on
// (Command Center for owners, office and dispatchers; My Day for drivers; My jobs for mechanics). Pure, so the items
// and the rule for showing the card are tested without a database.
//
// Each item is ticked from recorded data where that is cheap to read (done: true / false). An item whose result is
// not recorded anywhere (opening a page) has done: null and is ticked on the person's own device once they open it.
// Items need the permission for the action: a person never sees a step they cannot do.

import type { AppRole, Permission } from "@/lib/permissions";

export type ChecklistRole = "owner" | "office" | "dispatcher" | "driver" | "mechanic";
export type ChecklistPlace = "command-center" | "my-day" | "my-jobs";

/** Where each role lands after signing in, and so where its checklist is shown. */
export const CHECKLIST_PLACE: Record<ChecklistRole, ChecklistPlace> = {
  owner: "command-center", office: "command-center", dispatcher: "command-center", driver: "my-day", mechanic: "my-jobs",
};

/** "Your first steps as …". */
export const CHECKLIST_ROLE_WORDS: Record<ChecklistRole, string> = { owner: "the owner", office: "office staff", dispatcher: "a dispatcher", driver: "a driver", mechanic: "a mechanic" };

export function checklistRole(role: AppRole | null | undefined): ChecklistRole | null {
  return role === "owner" || role === "office" || role === "dispatcher" || role === "driver" || role === "mechanic" ? role : null;
}

/** What is already recorded. null = not read (missing update, no permission to read it, or not asked for). */
export interface GettingStartedFacts {
  companyPhone?: boolean | null;
  companyLogo?: boolean | null;
  trucks?: boolean | null;
  /** Someone besides the person signs in, or an invitation is waiting. */
  teamInvited?: boolean | null;
  customers?: boolean | null;
  orders?: boolean | null;
  myOrder?: boolean | null;
  myTicketReview?: boolean | null;
  myInvoice?: boolean | null;
  myAssignment?: boolean | null;
  myInspection?: boolean | null;
  myTicket?: boolean | null;
  myTimerStarted?: boolean | null;
  myTimerStopped?: boolean | null;
  /** The person's first load today on My Day, if any (the "open today's load" step links to it). */
  todayLoadAnchor?: string | null;
}

export interface GettingStartedItem {
  key: string;
  label: string;
  hint?: string;
  href: string;
  /** true / false from recorded data; null = ticked on this device once opened. */
  done: boolean | null;
}

type Can = (p: Permission) => boolean;
const tick = (v: boolean | null | undefined): boolean | null => (v === undefined || v === null ? null : v);

/** The person's first steps, in order. 3–5 for every role whose permissions allow them. */
export function gettingStartedItems(role: ChecklistRole, f: GettingStartedFacts, can: Can): GettingStartedItem[] {
  const items: Array<GettingStartedItem & { allowed: boolean }> = [];
  const add = (allowed: boolean, item: GettingStartedItem) => items.push({ ...item, allowed });
  switch (role) {
    case "owner":
      // The company phone first (owner 2026-11-09): drivers call it from My Day, customers see it on the portal.
      add(can("settings.manage"), {
        key: "phone",
        label: "Add your company phone so drivers and customers can call you",
        hint: f.companyLogo === false ? "Add your logo on the same page: it goes on quotes, invoices and the customer portal." : undefined,
        href: "/settings?tab=company#phone",
        done: tick(f.companyPhone),
      });
      add(can("fleet.edit"), { key: "truck", label: "Add a truck", href: "/fleet/trucks/new", done: tick(f.trucks) });
      add(can("users.manage") || can("employees.edit"), { key: "person", label: "Invite a person to your team", hint: "Drivers do not need an email: give them a username sign-in.", href: "/employees", done: tick(f.teamInvited) });
      add(can("customers.edit"), { key: "customer", label: "Create a customer", href: "/customers/new", done: tick(f.customers) });
      add(can("orders.edit"), { key: "order", label: "Create an order", href: "/orders/new", done: tick(f.orders) });
      break;
    case "office":
      add(can("orders.edit"), { key: "order", label: "Enter an order", href: "/orders/new", done: tick(f.myOrder) });
      add(can("tickets.review"), { key: "ticket", label: "Review a delivery ticket", hint: "Check the quantity against the order and accept it, or say what is wrong.", href: "/tickets?view=check", done: tick(f.myTicketReview) });
      add(can("billing.manage"), { key: "invoice", label: "Create an invoice draft", hint: "From an order handed off to billing. A draft is not sent to anyone.", href: "/billing?view=handed_off", done: tick(f.myInvoice) });
      add(can("customers.edit"), { key: "customer", label: "Create a customer", href: "/customers/new", done: tick(f.customers) });
      break;
    case "dispatcher":
      add(can("dispatch.view"), { key: "plan", label: "Open tomorrow's plan", hint: "See which loads still need a truck and a driver.", href: "/dispatch/plan", done: null });
      add(can("dispatch.edit"), { key: "assign", label: "Assign a load to a truck and driver", href: "/dispatch", done: tick(f.myAssignment) });
      add(can("comms.message"), { key: "message", label: "Send your drivers a message", href: "/communications", done: null });
      break;
    case "driver":
      add(can("driver.portal"), { key: "pretrip", label: "Do your pre-trip inspection", hint: "Before you drive: check every item. A problem goes straight to the shop.", href: "/driver#pre-trip", done: tick(f.myInspection) });
      add(can("driver.portal"), { key: "load", label: "Open today's load", hint: f.todayLoadAnchor ? undefined : "No load today yet: it appears on My Day as soon as dispatch assigns one.", href: `/driver${f.todayLoadAnchor ? `#${f.todayLoadAnchor}` : "#today-loads"}`, done: null });
      add(can("driver.portal"), { key: "ticket", label: "Send the ticket for a delivered load", href: "/driver#today-loads", done: tick(f.myTicket) });
      break;
    case "mechanic":
      // A timer started on a job means a job was opened (walkthrough 2026-11-11: it stayed unticked); else this device.
      add(can("maintenance.view"), { key: "job", label: "Open a job", href: "/maintenance/my-jobs", done: f.myTimerStarted || f.myTimerStopped ? true : null });
      add(can("maintenance.view"), { key: "start", label: "Start the timer on it", hint: "Your time goes on the job; you can fix a time later.", href: "/maintenance/my-jobs", done: tick(f.myTimerStarted) });
      add(can("maintenance.view"), { key: "stop", label: "Stop the timer when you finish", href: "/maintenance/my-jobs", done: tick(f.myTimerStopped) });
      break;
  }
  return items.filter((i) => i.allowed).map((i) => ({ key: i.key, label: i.label, hint: i.hint, href: i.href, done: i.done }));
}

/** Done on this device: recorded data, or opened here (items without a record). */
export const itemDone = (i: Pick<GettingStartedItem, "key" | "done">, opened: readonly string[]) => i.done === true || (i.done === null && opened.includes(i.key));

/**
 * Whether the card is shown: never in presentation mode, never once the person put it away, never with fewer than
 * two steps they can take, and no longer once every step is done.
 */
export function showChecklist(items: readonly GettingStartedItem[], s: { dismissed: boolean; presentation: boolean; opened?: readonly string[] }): boolean {
  if (s.dismissed || s.presentation || items.length < 2) return false;
  return items.some((i) => !itemDone(i, s.opened ?? []));
}

/** The browser key for this person in this company (opened steps and the fallback dismissal). */
export const checklistStorageKey = (companyId: string, userId: string) => `taviron-getting-started:${companyId}:${userId}`;

// Driver portal: plain-language labels and reminders. The database decides what
// a driver may see and do (driver_portal_home, driver_submit_ticket,
// driver_submit_field_report); this file only explains it.

import { addDays } from "@/lib/dates";
import { EXPIRY_WARNING_DAYS } from "@/lib/fleet/eligibility";
import type { TicketStatus } from "@/lib/tickets/rules";

export const REPORT_KINDS = ["delay", "cannot_complete", "breakdown", "equipment_issue", "inspection_issue"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  delay: "Running late",
  cannot_complete: "Can't complete the load",
  breakdown: "Breakdown",
  equipment_issue: "Equipment problem",
  inspection_issue: "Inspection problem",
};

export const REPORT_KIND_HELP: Record<ReportKind, string> = {
  delay: "Traffic, waiting at the pit or the site, weather.",
  cannot_complete: "Site closed, refused, wrong material, unsafe.",
  breakdown: "The truck or trailer cannot move.",
  equipment_issue: "Something is wrong but you can still drive safely.",
  inspection_issue: "Found during the pre- or post-trip inspection.",
};

/** Equipment reports name the truck or the trailer. */
export function reportNeedsEquipment(kind: ReportKind): boolean {
  return kind === "breakdown" || kind === "equipment_issue" || kind === "inspection_issue";
}

export const REPORT_STATUS_LABELS: Record<string, string> = {
  open: "Sent — not seen yet",
  acknowledged: "Seen by the office",
  resolved: "Resolved",
};

/** What a ticket's status means for the driver. */
export const DRIVER_TICKET_STATUS: Record<TicketStatus, string> = {
  submitted: "Sent — waiting for office review",
  needs_review: "Sent — the office will check it",
  accepted: "Accepted by the office",
  voided: "Voided by the office",
  superseded: "Replaced by a correction",
};

export interface DriverQualification {
  kind: string;
  cdl_class: string | null;
  expires_on: string | null;
  verified: boolean;
  description: string;
}

/** CDL and medical card reminders from the driver's own records (no inspection records exist yet). */
export function qualificationReminders(quals: DriverQualification[], today: string): Array<{ tone: "bad" | "warn"; text: string }> {
  const out: Array<{ tone: "bad" | "warn"; text: string }> = [];
  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  for (const [kind, name] of [["cdl", "CDL"], ["medical_card", "DOT medical card"]] as const) {
    const mine = quals.filter((q) => q.kind === kind);
    if (mine.length === 0) {
      out.push({ tone: "bad", text: `No ${name} is on record. Bring it to the office.` });
      continue;
    }
    const best = [...mine].sort((a, b) => (b.expires_on ?? "").localeCompare(a.expires_on ?? ""))[0];
    if (!best.expires_on) out.push({ tone: "warn", text: `Your ${name} expiry date is not on record.` });
    else if (best.expires_on < today) out.push({ tone: "bad", text: `Your ${name} expired on ${best.expires_on}. You cannot be assigned until it is renewed.` });
    else if (best.expires_on <= soon) out.push({ tone: "warn", text: `Your ${name} expires on ${best.expires_on}. Renew it soon.` });
    if (!best.verified) out.push({ tone: "warn", text: `Your ${name} has not been checked by the office yet.` });
  }
  return out;
}

export function siteAddress(site: { label: string; line1: string; line2: string; city: string; state: string; postal_code: string }): string {
  return [site.line1, site.line2, [site.city, site.state].filter(Boolean).join(", "), site.postal_code].filter(Boolean).join(" · ");
}

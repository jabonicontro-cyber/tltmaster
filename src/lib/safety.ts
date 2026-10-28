// Safety incidents (B103, migration 20261120004300): labels and the report's validation, shared by the office form, the
// driver's phone form and the pages. The database checks everything again.
import { z } from "zod";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";

export const INCIDENT_KINDS = {
  accident: "Accident",
  injury: "Injury",
  property_damage: "Property damage",
  spill: "Spill",
  near_miss: "Near miss",
  other: "Other",
} as const;
export type IncidentKind = keyof typeof INCIDENT_KINDS;

export const INCIDENT_SEVERITIES = { minor: "Minor", moderate: "Moderate", serious: "Serious" } as const;
export type IncidentSeverity = keyof typeof INCIDENT_SEVERITIES;

export const INCIDENT_STATUSES = {
  reported: "Reported",
  investigating: "Investigating",
  actions_open: "Actions open",
  closed: "Closed",
} as const;
export type IncidentStatus = keyof typeof INCIDENT_STATUSES;

export const STATUS_TONE: Record<IncidentStatus, "amber" | "blue" | "gray" | "green"> = {
  reported: "amber",
  investigating: "blue",
  actions_open: "blue",
  closed: "green",
};

const optionalId = z.string().trim().refine((v) => !v || z.uuid().safeParse(v).success, "Choose from the list.").default("");

export const incidentReport = z.object({
  kind: z.enum(Object.keys(INCIDENT_KINDS) as [IncidentKind, ...IncidentKind[]], "Choose what happened."),
  severity: z.enum(Object.keys(INCIDENT_SEVERITIES) as [IncidentSeverity, ...IncidentSeverity[]]).default("minor"),
  date: z.string().trim().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE),
  time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter the time it happened."),
  location: z.string().trim().max(300).default(""),
  description: z.string().trim().min(1, "Describe what happened.").max(4000),
  injury: z.boolean().default(false),
  vehicle_damage: z.boolean().default(false),
  truck_id: optionalId,
  driver_id: optionalId,
});
export type IncidentReportInput = z.input<typeof incidentReport>;

/** "14:05": the time now in a time zone, for the report form's default. */
export function clockNow(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

import "server-only";
import type { DriverQualification, ReportKind } from "@/lib/driver/rules";
import { uuid } from "@/lib/schemas/common";
import type { TicketStatus } from "@/lib/tickets/rules";
import { createClient } from "@/server/supabase/server";

export interface DriverAssignment {
  assignment_id: string;
  assignment_note: string;
  load: { id: string; number: number; date: string; start_time: string; end_time: string; planned_quantity: number | string | null; unit_code: string | null; notes: string };
  order: { number: string; status: string; customer_name: string | null; project_name: string; customer_po: string; contact_name: string; contact_phone: string; job_instructions: string };
  site: { label: string; line1: string; line2: string; city: string; state: string; postal_code: string; directions: string | null };
  truck: string | null;
  trailer: string | null;
  tickets: Array<{ id: string; number: string; status: TicketStatus; quantity: number | string; unit_code: string }>;
  can_submit_ticket: boolean;
}

export interface DriverHome {
  driver: { name: string };
  today: string;
  timezone: string;
  assignments: DriverAssignment[];
  tickets: Array<{ id: string; number: string; revision: number; status: TicketStatus; quantity: number | string; unit_code: string; delivered_at: string; order_number: string; load_number: string; review_reasons: string[] }>;
  qualifications: DriverQualification[];
  reports: Array<{ id: string; kind: ReportKind; status: string; created_at: string; order_number: string; load_number: string; equipment_unit: string | null }>;
}

/** The portal can fail for one expected reason: the account is not linked to a driver record. */
export type DriverResult<T> = { ok: true; data: T } | { ok: false; notLinked: boolean; error: string };

function failure(error: { code?: string; message?: string } | null): { ok: false; notLinked: boolean; error: string } {
  const notLinked = /not linked to an active driver/i.test(error?.message ?? "");
  if (notLinked) return { ok: false, notLinked, error: error!.message! };
  if (error?.code === "42501") return { ok: false, notLinked: false, error: error.message ?? "Not permitted." };
  return { ok: false, notLinked: false, error: "Your day could not be loaded. Check your signal and try again." };
}

export async function loadDriverHome(): Promise<DriverResult<DriverHome>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("driver_portal_home");
  if (error || !data) return failure(error);
  return { ok: true, data: data as DriverHome };
}

export interface DriverForm extends DriverAssignment {
  today: string;
  timezone: string;
  lines: Array<{ id: string; line_no: number; description: string; unit_code: string }>;
  units: Array<{ code: string; label: string }>;
}

export async function loadAssignmentForm(assignmentId: string): Promise<DriverResult<DriverForm> | null> {
  if (!uuid.safeParse(assignmentId).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("driver_assignment_form", { p_assignment_id: assignmentId });
  if (error || !data) return failure(error);
  return { ok: true, data: data as DriverForm };
}

export interface MaintenanceNotice {
  number: string;
  unit_number: string;
  /** "trailer" for a trailer usually pulled by the driver's truck; absent before trailer work orders exist. */
  equipment?: "truck" | "trailer";
  title: string;
  status: string;
  scheduled_for: string | null;
  safety_critical: boolean;
  notice: "scheduled" | "rescheduled" | "canceled";
  notice_at: string;
  previous_date: string | null;
}

/**
 * Shop appointments for the driver's primary truck (or naming the driver):
 * scheduled, rescheduled or canceled. In-app only — nothing is sent. Empty when
 * the maintenance tables are not installed yet.
 */
export async function loadMaintenanceNotices(): Promise<MaintenanceNotice[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("driver_maintenance_notices");
  if (error || !Array.isArray(data)) return [];
  return data as MaintenanceNotice[];
}

export interface DispatchUpdate { id: string; title: string; created_at: string }

const DISPATCH_EVENTS = ["dispatch.assignment_new", "dispatch.assignment_changed"];

/**
 * Unread notices from dispatch about the driver's own loads (new load, date or time changed; 20261114000500): the
 * driver's own in-app notifications whose alert is one of those types (row-level security on both), last 7 days,
 * newest first. Empty when Communications is not installed.
 */
export async function loadDispatchUpdates(): Promise<DispatchUpdate[]> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data, error } = await supabase.from("comm_notifications").select("id, title, created_at, source_id")
    .eq("category", "alert").eq("state", "visible").is("read_at", null).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(50);
  if (error || !data?.length) return [];
  const rows = data as Array<DispatchUpdate & { source_id: string | null }>;
  const sources = [...new Set(rows.map((r) => r.source_id).filter((x): x is string => Boolean(x)))];
  if (!sources.length) return [];
  const alerts = await supabase.from("alerts").select("id").in("id", sources).in("event_type", DISPATCH_EVENTS);
  if (alerts.error) return [];
  const ours = new Set(((alerts.data ?? []) as Array<{ id: string }>).map((a) => a.id));
  return rows.filter((r) => r.source_id && ours.has(r.source_id)).slice(0, 5).map(({ id, title, created_at }) => ({ id, title, created_at }));
}

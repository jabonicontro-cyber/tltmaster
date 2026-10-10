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

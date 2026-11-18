import "server-only";
import type { MistakeField } from "@/lib/tickets/mistakes";
import { createClient } from "@/server/supabase/server";

// "Mistake on my ticket" reports (TM1, migration 20261120024720), read with the person's own session: people who see
// tickets (tickets.view) read the company's; a driver reads their own. Before that update is installed: none.

export interface MistakeReport {
  id: string;
  ticket_id: string;
  ticket_number: string;
  driver_id: string;
  field: MistakeField;
  correct_value: string;
  note: string;
  has_photo: boolean;
  status: "open" | "resolved";
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string;
}

const COLUMNS = "id, ticket_id, ticket_number, driver_id, field, correct_value, note, photo_path, status, created_at, resolved_by, resolved_at, resolution_note";
type Raw = Omit<MistakeReport, "has_photo"> & { photo_path: string | null };
const shape = (r: Raw): MistakeReport => {
  const { photo_path, ...rest } = r;
  return { ...rest, has_photo: Boolean(photo_path) };
};

/** Open reports, oldest first (the review queue). */
export async function listOpenMistakes(): Promise<MistakeReport[]> {
  const { data, error } = await (await createClient()).from("ticket_mistake_reports").select(COLUMNS).eq("status", "open").order("created_at").limit(200);
  if (error) return [];
  return ((data ?? []) as Raw[]).map(shape);
}

/** Every report on one ticket (all its revisions share the ticket number), newest first. */
export async function mistakesForTicket(ticketNumber: string): Promise<MistakeReport[]> {
  const { data, error } = await (await createClient()).from("ticket_mistake_reports").select(COLUMNS).eq("ticket_number", ticketNumber).order("created_at", { ascending: false }).limit(50);
  if (error) return [];
  return ((data ?? []) as Raw[]).map(shape);
}

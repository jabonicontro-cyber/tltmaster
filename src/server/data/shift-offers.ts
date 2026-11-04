import "server-only";
import type { OfferAudience, OfferMode, OfferStatus, ResponseStatus } from "@/lib/schedule/offers";
import { createClient } from "@/server/supabase/server";

// Shift offers (B102, migration 20261120004700), read through the person's session. Planners and dispatch read the
// company's offers (RLS); everyone reads the offers open to them through public.my_shift_offers(). Before the
// migration is installed the loaders say so instead of failing the page.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export interface ShiftOffer {
  id: string;
  workDate: string;
  start: string;
  end: string;
  breakMinutes: number;
  audience: OfferAudience;
  mode: OfferMode;
  note: string;
  status: OfferStatus;
  filledEmployee: string | null;
  cancelReason: string;
  createdAt: string;
  targets: string[];
  responses: Array<{ id: string; employeeId: string; status: ResponseStatus; createdAt: string }>;
}

export interface MyShiftOffer {
  id: string;
  workDate: string;
  start: string;
  end: string;
  breakMinutes: number;
  mode: OfferMode;
  note: string;
  offerStatus: OfferStatus;
  myStatus: ResponseStatus | null;
  problem: string | null;
}

const hhmm = (t: string) => t.slice(0, 5);

/** The company's shift offers from a date on (open and recent), with who was offered and who answered. */
export async function listShiftOffers(from: string): Promise<{ installed: boolean; mode: OfferMode; offers: ShiftOffer[] }> {
  const supabase = await createClient();
  const [offers, settings] = await Promise.all([
    supabase.from("shift_offers")
      .select("id, work_date, start_time, end_time, break_minutes, audience, mode, note, status, filled_employee, cancel_reason, created_at, shift_offer_targets(employee_id), shift_offer_responses(id, employee_id, status, created_at)")
      .gte("work_date", from).order("work_date").order("start_time").limit(60),
    supabase.from("shift_offer_settings").select("mode").maybeSingle(),
  ]);
  if (offers.error) {
    if (MISSING.has(offers.error.code ?? "")) return { installed: false, mode: "request", offers: [] };
    throw new Error(`Shift offers: ${offers.error.message}`);
  }
  type Row = { id: string; work_date: string; start_time: string; end_time: string; break_minutes: number; audience: OfferAudience; mode: OfferMode; note: string; status: OfferStatus; filled_employee: string | null; cancel_reason: string; created_at: string; shift_offer_targets: Array<{ employee_id: string }>; shift_offer_responses: Array<{ id: string; employee_id: string; status: ResponseStatus; created_at: string }> };
  return {
    installed: true,
    mode: ((settings.data as { mode?: OfferMode } | null)?.mode ?? "request"),
    offers: ((offers.data ?? []) as Row[]).map((o) => ({
      id: o.id, workDate: o.work_date, start: hhmm(o.start_time), end: hhmm(o.end_time), breakMinutes: o.break_minutes, audience: o.audience, mode: o.mode,
      note: o.note, status: o.status, filledEmployee: o.filled_employee, cancelReason: o.cancel_reason, createdAt: o.created_at,
      targets: o.shift_offer_targets.map((t) => t.employee_id),
      responses: [...o.shift_offer_responses].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => ({ id: r.id, employeeId: r.employee_id, status: r.status, createdAt: r.created_at })),
    })),
  };
}

/** Offers open to the signed-in person, and the ones they answered. Null before the migration is installed. */
export async function myShiftOffers(place?: "drivers" | "shop"): Promise<MyShiftOffer[] | null> {
  const supabase = await createClient();
  const [{ data, error }, audiences] = await Promise.all([
    supabase.rpc("my_shift_offers"),
    // Each page lists only the offers meant for it (UX14): My Day driver and everyone offers, My jobs shop and everyone
    // offers, also for a person who is both. Before migration 20261120007100 every offer is listed.
    place ? supabase.rpc("my_shift_offer_audiences") : Promise.resolve({ data: null, error: null }),
  ]);
  if (error) {
    if (MISSING.has(error.code ?? "")) return null;
    throw new Error(`Shift offers: ${error.message}`);
  }
  const audience = new Map(((audiences.error ? [] : audiences.data ?? []) as Array<{ id: string; audience: string }>).map((r) => [r.id, r.audience]));
  const meant = (id: string) => !place || !audience.has(id) || audience.get(id) === "everyone" || audience.get(id) === place;
  type Row = { id: string; work_date: string; start_time: string; end_time: string; break_minutes: number; mode: OfferMode; note: string; offer_status: OfferStatus; my_status: ResponseStatus | null; problem: string | null };
  return ((data ?? []) as Row[]).filter((r) => meant(r.id)).map((r) => ({
    id: r.id, workDate: r.work_date, start: hhmm(r.start_time), end: hhmm(r.end_time), breakMinutes: r.break_minutes, mode: r.mode, note: r.note,
    offerStatus: r.offer_status, myStatus: r.my_status, problem: r.problem,
  }));
}

/** The company's mode (Settings). */
export async function shiftOfferMode(): Promise<{ installed: boolean; mode: OfferMode }> {
  const { data, error } = await (await createClient()).from("shift_offer_settings").select("mode").maybeSingle();
  if (error) return { installed: !MISSING.has(error.code ?? ""), mode: "request" };
  return { installed: true, mode: ((data as { mode?: OfferMode } | null)?.mode ?? "request") };
}

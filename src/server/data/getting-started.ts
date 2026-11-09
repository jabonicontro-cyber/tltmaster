import "server-only";
import { cookies } from "next/headers";
import { checklistRole, checklistStorageKey, CHECKLIST_PLACE, gettingStartedItems, showChecklist, type ChecklistPlace, type ChecklistRole, type GettingStartedFacts, type GettingStartedItem } from "@/lib/getting-started";
import { can, type Access, type Permission } from "@/lib/permissions";
import { PRESENTATION_COOKIE } from "@/lib/platform/preview";
import { createClient } from "@/server/supabase/server";
import { getSettings } from "./settings";

export interface GettingStartedView {
  role: ChecklistRole;
  items: GettingStartedItem[];
  storageKey: string;
}

/**
 * The signed-in person's "Getting started" checklist for the page they are on, or null when it is not shown there
 * (another role's landing page, put away, presentation mode, every step done). Every fact is read with the person's
 * own session (RLS, current company only) and is cheap: one row at most per question. A read that fails leaves its
 * step as a plain link rather than claiming it is done.
 */
export async function loadGettingStarted(access: Access, place: ChecklistPlace, extra: GettingStartedFacts = {}): Promise<GettingStartedView | null> {
  const role = checklistRole(access.role);
  if (!role || CHECKLIST_PLACE[role] !== place || !access.companyId) return null;
  const jar = await cookies();
  // Presentation mode (demo companies, screenshots and live demos): the card is never shown.
  const presentation = jar.get(PRESENTATION_COOKIE)?.value === "1";
  if (presentation) return null;
  const supabase = await createClient();
  const pref = await supabase.from("user_preferences").select("key").eq("key", "getting_started").maybeSingle();
  if (!pref.error && pref.data) return null;

  const has = (p: Permission) => can(access, p);
  const me = access.userId;
  /** One row or none; null when it cannot be read (missing update, no permission). */
  const any = async (q: PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<boolean | null> => {
    const r = await q;
    return r.error ? null : (r.data ?? []).length > 0;
  };
  const facts: GettingStartedFacts = { ...extra };
  if (role === "owner") {
    const [settings, trucks, members, customers, orders] = await Promise.all([
      getSettings().catch(() => null),
      has("fleet.view") ? any(supabase.from("trucks").select("id").limit(1)) : null,
      has("users.manage") ? supabase.from("company_memberships").select("user_id").eq("company_id", access.companyId).limit(2).then((r) => (r.error ? null : (r.data ?? []).length > 1)) : null,
      has("customers.view") ? any(supabase.from("customers").select("id").limit(1)) : null,
      has("orders.view") ? any(supabase.from("orders").select("id").limit(1)) : null,
    ]);
    Object.assign(facts, {
      companyPhone: settings ? Boolean(settings.phone?.trim()) : null,
      companyLogo: settings ? Boolean(settings.has_logo) : null,
      trucks, teamInvited: members, customers, orders,
    });
  } else if (role === "office") {
    const [myOrder, myTicketReview, myInvoice, customers] = await Promise.all([
      has("orders.view") ? any(supabase.from("orders").select("id").eq("created_by", me).limit(1)) : null,
      has("tickets.view") ? any(supabase.from("delivery_tickets").select("id").eq("reviewed_by", me).limit(1)) : null,
      has("billing.view") ? any(supabase.from("invoices").select("id").eq("created_by", me).limit(1)) : null,
      has("customers.view") ? any(supabase.from("customers").select("id").limit(1)) : null,
    ]);
    Object.assign(facts, { myOrder, myTicketReview, myInvoice, customers });
  } else if (role === "dispatcher") {
    facts.myAssignment = has("dispatch.view") ? await any(supabase.from("dispatch_assignments").select("id").eq("created_by", me).limit(1)) : null;
  } else if (role === "driver") {
    // The driver's own inspections are readable to them (row-level security); before the inspections update: null.
    facts.myInspection = await any(supabase.from("vehicle_inspections").select("id").eq("created_by", me).limit(1));
  } else if (role === "mechanic") {
    const [started, stopped] = await Promise.all([
      any(supabase.from("work_order_time_entries").select("id").eq("user_id", me).limit(1)),
      any(supabase.from("work_order_time_entries").select("id").eq("user_id", me).not("ended_at", "is", null).limit(1)),
    ]);
    Object.assign(facts, { myTimerStarted: started, myTimerStopped: stopped });
  }

  const items = gettingStartedItems(role, facts, has);
  // Steps opened on this device (and a dismissal remembered only in this browser) are known there; the card checks them.
  if (!showChecklist(items, { dismissed: false, presentation: false })) return null;
  return { role, items, storageKey: checklistStorageKey(access.companyId, access.userId) };
}

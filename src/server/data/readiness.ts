import "server-only";
import { qualificationCheck, type EligibilityQualification } from "@/lib/fleet/eligibility";
import { assessReadiness, type Readiness } from "@/lib/onboarding/readiness";
import { createClient } from "@/server/supabase/server";
import { businessToday, getSettings } from "./settings";

/**
 * Counts for the company setup checklist, read with the signed-in person's own access (RLS, current company only).
 * Throws when something cannot be read: a checklist built from partial data could show a false all-clear.
 */
export async function getCompanyReadiness(companyId: string): Promise<Readiness> {
  // companyId scopes the membership count; every other query is limited to the current company by RLS.
  const supabase = await createClient();
  const { today } = await businessToday();
  const [settings, members, customers, materials, standard, trucks, trailers, drivers, quals, employees] = await Promise.all([
    getSettings().then((data) => ({ data, error: null }), (e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : "settings" } })),
    supabase.from("company_memberships").select("role").eq("company_id", companyId).eq("active", true),
    supabase.from("customers").select("email, billing_line1, billing_city").eq("active", true),
    supabase.from("materials").select("id").eq("active", true),
    supabase.from("price_list_entries").select("material_id, effective_from, effective_to, price_lists!inner(is_standard, active)").eq("price_lists.is_standard", true).eq("price_lists.active", true).not("material_id", "is", null),
    supabase.from("trucks").select("truck_type, service_status, weight_capacity, volume_capacity, capacity_verified_at").eq("active", true),
    supabase.from("trailers").select("weight_capacity, volume_capacity, compatible_truck_types").eq("active", true),
    supabase.from("drivers").select("id, user_id").eq("active", true),
    supabase.from("driver_qualifications").select("driver_id, kind, cdl_class, expires_on, verified_at"),
    supabase.from("employees").select("driver_id, user_id").not("driver_id", "is", null),
  ]);
  for (const r of [settings, members, customers, materials, standard, trucks, trailers, drivers, quals, employees]) {
    if (r.error) throw new Error(`The setup checklist could not read your company's data: ${r.error.message}`);
  }
  const s = (settings.data ?? {}) as unknown as Record<string, string | null>;
  const present = (...keys: string[]) => keys.every((k) => Boolean((s[k] ?? "").trim()));
  const rated = new Set(((standard.data ?? []) as Array<{ material_id: string; effective_from: string | null; effective_to: string | null }>)
    .filter((e) => (!e.effective_from || e.effective_from <= today) && (!e.effective_to || e.effective_to >= today))
    .map((e) => e.material_id));
  const truckRows = (trucks.data ?? []) as Array<{ truck_type: string; service_status: string; weight_capacity: unknown; volume_capacity: unknown; capacity_verified_at: string | null }>;
  const known = (t: { weight_capacity: unknown; volume_capacity: unknown }) => t.weight_capacity !== null || t.volume_capacity !== null;
  const trailerRows = (trailers.data ?? []) as Array<{ weight_capacity: unknown; volume_capacity: unknown; compatible_truck_types: string[] | null }>;
  const qualsBy = new Map<string, EligibilityQualification[]>();
  for (const q of (quals.data ?? []) as Array<EligibilityQualification & { driver_id: string }>) qualsBy.set(q.driver_id, [...(qualsBy.get(q.driver_id) ?? []), q]);
  const driverRows = (drivers.data ?? []) as Array<{ id: string; user_id: string | null }>;
  const linked = new Set(((employees.data ?? []) as Array<{ driver_id: string; user_id: string | null }>).filter((e) => e.user_id).map((e) => e.driver_id));
  const state = (id: string, kind: "cdl" | "medical_card") => qualificationCheck(qualsBy.get(id) ?? [], kind, kind === "cdl" ? "B" : null, today);

  return assessReadiness({
    company: {
      name: s.company_name ?? "",
      timezone: s.timezone ?? "",
      addressComplete: present("address_line1", "city", "state", "postal_code"),
      contactComplete: present("phone") || present("email"),
      hasLogo: Boolean(settings.data?.has_logo),
    },
    users: { active: (members.data ?? []).length, roles: [...new Set(((members.data ?? []) as Array<{ role: string | null }>).map((m) => m.role).filter((r): r is string => Boolean(r)))] },
    customers: {
      active: (customers.data ?? []).length,
      withoutBillingAddress: ((customers.data ?? []) as Array<{ billing_line1: string | null; billing_city: string | null }>).filter((c) => !c.billing_line1?.trim() || !c.billing_city?.trim()).length,
      withoutEmail: ((customers.data ?? []) as Array<{ email: string | null }>).filter((c) => !c.email?.trim()).length,
    },
    materials: { active: (materials.data ?? []).length, withoutStandardRate: ((materials.data ?? []) as Array<{ id: string }>).filter((m) => !rated.has(m.id)).length },
    trucks: {
      active: truckRows.length,
      capacityUnknown: truckRows.filter((t) => t.truck_type !== "tractor" && !known(t)).length,
      capacityUnverified: truckRows.filter((t) => t.truck_type !== "tractor" && known(t) && !t.capacity_verified_at).length,
      outOfService: truckRows.filter((t) => t.service_status === "out_of_service").length,
    },
    trailers: { active: trailerRows.length, capacityUnknown: trailerRows.filter((t) => !known(t)).length, compatibilityUnknown: trailerRows.filter((t) => !(t.compatible_truck_types ?? []).length).length },
    tractors: truckRows.filter((t) => t.truck_type === "tractor").length,
    drivers: {
      active: driverRows.length,
      withoutValidCdl: driverRows.filter((d) => ["missing", "class_insufficient", "expired", "expiry_unknown"].includes(state(d.id, "cdl"))).length,
      withoutValidMedical: driverRows.filter((d) => ["missing", "expired", "expiry_unknown"].includes(state(d.id, "medical_card"))).length,
      unverified: driverRows.filter((d) => state(d.id, "cdl") === "unverified" || state(d.id, "medical_card") === "unverified").length,
      withoutLogin: driverRows.filter((d) => !d.user_id && !linked.has(d.id)).length,
    },
  });
}

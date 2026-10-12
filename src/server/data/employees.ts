import "server-only";
import { displayLogin } from "@/lib/usernames";
import { createClient } from "@/server/supabase/server";
import { ilikePattern, PAGE_SIZE } from "@/server/data/search";
import type { Department, EmployeeStatus, EmploymentType, PayType } from "@/lib/employees";

export interface EmployeeRow {
  id: string;
  user_id: string | null;
  driver_id: string | null;
  full_name: string;
  job_title: string;
  department: Department;
  employment_type: EmploymentType;
  status: EmployeeStatus;
  hire_date: string | null;
  end_date: string | null;
  work_email: string;
  work_phone: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  notes: string;
  avatar_key: string;
  updated_at: string;
}

export interface EmployeeFilters {
  q?: string;
  status?: string;
  department?: string;
  kind?: string; // "drivers" | "logins" | ""
  page: number;
}

/** The company's directory (row-level security: employees.view, or only your own record). */
export async function listEmployees(f: EmployeeFilters) {
  const supabase = await createClient();
  let query = supabase
    .from("employees")
    .select("id, user_id, driver_id, full_name, job_title, department, employment_type, status, hire_date, work_email, work_phone, avatar_key, updated_at", { count: "exact" })
    .order("full_name");
  const pattern = ilikePattern(f.q);
  if (pattern) query = query.or(`full_name.ilike.${pattern},job_title.ilike.${pattern},work_email.ilike.${pattern},work_phone.ilike.${pattern}`);
  if (f.status === "all") {
    // every status
  } else if (f.status && ["active", "on_leave", "inactive", "terminated"].includes(f.status)) query = query.eq("status", f.status);
  else query = query.in("status", ["active", "on_leave"]);
  if (f.department && f.department !== "all") query = query.eq("department", f.department);
  if (f.kind === "drivers") query = query.not("driver_id", "is", null);
  if (f.kind === "logins") query = query.not("user_id", "is", null);
  const from = (f.page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(`Could not load employees: ${error.message}`);
  const rows = (data ?? []) as Array<Pick<EmployeeRow, "id" | "user_id" | "driver_id" | "full_name" | "job_title" | "department" | "employment_type" | "status" | "hire_date" | "work_email" | "work_phone" | "avatar_key" | "updated_at">>;

  // Primary trucks for the drivers on this page (visible with fleet.view; otherwise left out).
  const driverIds = rows.map((r) => r.driver_id).filter((v): v is string => Boolean(v));
  const trucks = new Map<string, string>();
  if (driverIds.length) {
    const { data: d } = await supabase.from("drivers").select("id, primary_truck_id").in("id", driverIds);
    const held = ((d ?? []) as Array<{ id: string; primary_truck_id: string | null }>).filter((r) => r.primary_truck_id);
    if (held.length) {
      const { data: t } = await supabase.from("trucks").select("id, unit_number").in("id", held.map((r) => r.primary_truck_id!));
      const unit = new Map(((t ?? []) as Array<{ id: string; unit_number: string }>).map((x) => [x.id, x.unit_number]));
      for (const r of held) if (unit.has(r.primary_truck_id!)) trucks.set(r.id, unit.get(r.primary_truck_id!)!);
    }
  }
  return { rows: rows.map((r) => ({ ...r, primary_truck: r.driver_id ? trucks.get(r.driver_id) ?? null : null })), total: count ?? 0 };
}

export interface Qualification { id: string; kind: string; cdl_class: string | null; expires_on: string | null; verified_at: string | null }

export interface EmployeeDetail {
  employee: EmployeeRow;
  role: string | null; // visible with users.manage
  driver: null | {
    id: string;
    name: string;
    active: boolean;
    primaryTruck: { id: string; unit: string } | null;
    qualifications: Qualification[];
  };
  compensation: null | { pay_type: PayType; rate_cents: number | null; rate_percent: number | null; effective_date: string | null; notes: string; updated_at: string };
  trucks: Array<{ id: string; unit: string; heldBy: string | null }>; // for the primary-truck picker
}

export async function getEmployee(id: string, opts: { compensation: boolean; trucks: boolean }): Promise<EmployeeDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("employees").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load the employee: ${error.message}`);
  if (!data) return null;
  const employee = data as EmployeeRow;

  const [membership, driver, quals, comp, trucks] = await Promise.all([
    employee.user_id ? supabase.from("company_memberships").select("role").eq("user_id", employee.user_id).maybeSingle() : Promise.resolve({ data: null }),
    employee.driver_id ? supabase.from("drivers").select("id, name, active, primary_truck_id").eq("id", employee.driver_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    employee.driver_id ? supabase.from("driver_qualifications").select("id, kind, cdl_class, expires_on, verified_at").eq("driver_id", employee.driver_id).order("kind") : Promise.resolve({ data: [] }),
    opts.compensation ? supabase.from("employee_compensation").select("pay_type, rate_cents, rate_percent, effective_date, notes, updated_at").eq("employee_id", id).maybeSingle() : Promise.resolve({ data: null }),
    opts.trucks && employee.driver_id ? supabase.from("trucks").select("id, unit_number").eq("active", true).order("unit_number") : Promise.resolve({ data: [] }),
  ]);
  if (driver.error) throw new Error(`Could not load the driver record: ${driver.error.message}`);
  const raw = driver.data as { id: string; name: string; active: boolean; primary_truck_id: string | null } | null;
  // Which active driver holds each truck (for the picker), and this driver's own truck.
  const holders = new Map<string, string>();
  if (opts.trucks && raw) {
    // Every active driver who holds a truck (bounded by the number of drivers, not trucks).
    const { data: h, error: hErr } = await supabase.from("drivers").select("name, primary_truck_id").eq("active", true).not("primary_truck_id", "is", null);
    if (hErr) throw new Error(`Could not load truck assignments: ${hErr.message}`);
    for (const r of (h ?? []) as Array<{ name: string; primary_truck_id: string }>) holders.set(r.primary_truck_id, r.name);
  }
  let own: { id: string; unit_number: string } | null = null;
  if (raw?.primary_truck_id) {
    const { data: t } = await supabase.from("trucks").select("id, unit_number").eq("id", raw.primary_truck_id).maybeSingle();
    own = (t as { id: string; unit_number: string } | null) ?? null;
  }
  const d = raw ? { ...raw, trucks: own } : null;
  const c = comp.data as (EmployeeDetail["compensation"] & { rate_cents: number | string | null; rate_percent: number | string | null }) | null;
  return {
    employee,
    role: (membership.data as { role: string } | null)?.role ?? null,
    driver: d ? { id: d.id, name: d.name, active: d.active, primaryTruck: d.trucks ? { id: d.trucks.id, unit: d.trucks.unit_number } : null, qualifications: (quals.data ?? []) as Qualification[] } : null,
    compensation: c ? { ...c, rate_cents: c.rate_cents === null ? null : Number(c.rate_cents), rate_percent: c.rate_percent === null ? null : Number(c.rate_percent) } : null,
    trucks: ((trucks.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => ({ id: t.id, unit: t.unit_number, heldBy: holders.get(t.id) ?? null })),
  };
}

/**
 * Logins of the current company that no employee record uses yet (to link one). Needs users.manage to read
 * memberships and names; returns [] otherwise. Shown as "Name — username/email".
 */
export async function linkableLogins(companyId: string): Promise<Array<{ user_id: string; label: string }>> {
  const supabase = await createClient();
  const [members, linked] = await Promise.all([
    // RLS also returns the caller's own memberships in other companies: filter to this company.
    supabase.from("company_memberships").select("user_id, role, active, profiles(email, full_name)").eq("company_id", companyId).eq("active", true),
    supabase.from("employees").select("user_id").not("user_id", "is", null),
  ]);
  if (members.error) return [];
  const taken = new Set(((linked.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  return ((members.data ?? []) as unknown as Array<{ user_id: string; role: string | null; profiles: { email: string; full_name: string } | null }>)
    .filter((m) => m.role && !taken.has(m.user_id))
    .map((m) => {
      const login = displayLogin(m.profiles?.email ?? "");
      return { user_id: m.user_id, label: m.profiles?.full_name ? `${m.profiles.full_name} — ${login}` : login };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * When each person's profile photo last changed (only people with a photo, in the caller's company), so pages
 * request only photos that exist, with a versioned URL. null = the database function is not installed yet
 * (migration 20261107000100): callers then request every linked person's photo, as before.
 */
export async function photoVersions(userIds: Array<string | null>): Promise<Map<string, string> | null> {
  const ids = [...new Set(userIds.filter((v): v is string => Boolean(v)))];
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("profile_photo_versions", { p_user_ids: ids });
  if (error) return null;
  return new Map(((data ?? []) as Array<{ user_id: string; updated_at: string }>).map((r) => [r.user_id, r.updated_at]));
}


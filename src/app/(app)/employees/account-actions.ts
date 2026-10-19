"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { ROLES, type AppRole } from "@/lib/permissions";
import { isUsernameEmail } from "@/lib/usernames";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import {
  blockIfUnused, emailSetupLink, issueSetup, loginUrl, NOT_INSTALLED, reissue, reserveAndCreate, unblock, type IssuedCredential,
} from "@/server/accounts";
import { createClient } from "@/server/supabase/server";

// Employee sign-ins with a username (docs/ACCOUNT_PROVISIONING.md). users.manage creates and manages sign-ins;
// employees.edit is needed too because a person record is created or linked. Every step is checked again by the
// database. A temporary password is returned once to the administrator and never stored.

const DEPARTMENT_FOR_ROLE: Record<AppRole, string> = { owner: "management", dispatcher: "dispatch", office: "office", mechanic: "shop", driver: "operations" };
const uuid = z.uuid();

async function staff() {
  const access = await assertPermission("users.manage");
  return access;
}

export async function checkUsername(username: string): Promise<{ valid: boolean; available: boolean } | null> {
  await staff();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("account_username_available", { p_username: username, p_kind: "employee" });
  if (error) return null;
  return data as { valid: boolean; available: boolean };
}

const createSchema = z.object({
  request_key: uuid,
  employee_id: z.union([uuid, z.literal("")]).default(""),
  full_name: z.string().trim().min(2, "Enter the person's name.").max(120),
  job_title: z.string().trim().max(80).default(""),
  username: z.string().trim().min(3, "Choose a username.").max(32),
  email: z.union([z.email("Enter a valid email or leave it empty."), z.literal("")]).default(""),
  phone: z.string().trim().max(30).default(""),
  role: z.enum(ROLES),
  status: z.enum(["active", "inactive"]).default("active"),
  bases: z.string().default(""),
});

export interface CreatedSignIn extends IssuedCredential {
  employeeId: string;
  personName: string;
  loginUrl: string;
}

export async function createEmployeeSignIn(formData: FormData): Promise<ActionResult<CreatedSignIn>> {
  const access = await staff();
  if (!access.permissions.includes("employees.edit")) return fail("Creating a sign-in also creates the person record: you need permission to edit people.");
  if (access.isDemo) return fail("Demo companies do not create sign-ins: nothing real is created from a demo.");
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
  }
  const p = parsed.data;
  if (p.role === "owner" && access.role !== "owner") return fail("Only an owner can add another owner.", { role: "Only an owner can add another owner." });
  if (p.email && isUsernameEmail(p.email)) return fail("Enter the person's own email, or leave it empty.", { email: "Enter the person's own email." });
  const bases = p.bases.split(",").map((b) => b.trim()).filter(Boolean);
  if (bases.some((b) => !uuid.safeParse(b).success)) return fail("Choose bases from the list.");

  const created = await reserveAndCreate("employee", p.request_key, p.username, p.full_name);
  if (!created.ok) return created.error.includes("taken") ? fail(created.error, { username: created.error }) : created;
  const { userId, username, temporaryPassword } = created.data;
  const supabase = await createClient();

  // Membership with the chosen role (the database checks users.manage and the owner rule). A retry finds it already.
  const member = await supabase.rpc("add_company_member", { p_user_id: userId, p_role: p.role, p_full_name: p.full_name });
  if (member.error && !/already a member/i.test(member.error.message)) return fail(dbErrorMessage(member.error));
  if (bases.length) {
    const b = await supabase.rpc("set_person_bases", { p_user: userId, p_bases: bases });
    if (b.error && b.error.code !== "PGRST202") return fail(`The sign-in was created, but the bases were not saved: ${dbErrorMessage(b.error)}`);
  }

  // The person record: the chosen one, else one already linked (a retry), else a new one.
  let employeeId = p.employee_id;
  const linked = await supabase.from("employees").select("id").eq("user_id", userId).limit(1);
  if (linked.data?.length) employeeId = (linked.data[0] as { id: string }).id;
  else if (employeeId) {
    const upd = await supabase.from("employees").update({ user_id: userId }).eq("id", employeeId).is("user_id", null).select("id");
    if (!upd.data?.length) return fail("That person already has a sign-in, or was not found.");
  } else {
    const ins = await supabase.from("employees").insert({
      full_name: p.full_name, job_title: p.job_title, department: DEPARTMENT_FOR_ROLE[p.role], status: "active",
      work_email: p.email, work_phone: p.phone, user_id: userId,
    }).select("id");
    if (ins.error || !ins.data?.length) return fail(`The sign-in was created, but the person record was not: ${dbErrorMessage(ins.error)}`);
    employeeId = (ins.data[0] as { id: string }).id;
  }
  if (p.status === "inactive") {
    const off = await supabase.rpc("set_user_access", { p_user_id: userId, p_role: p.role, p_active: false, p_full_name: p.full_name });
    if (off.error) return fail(dbErrorMessage(off.error));
  }
  await supabase.rpc("account_employee_created", { p_request_key: p.request_key });
  const issued = await issueSetup("employee", userId, "print");
  if (!issued.ok) return issued;
  revalidatePath("/employees", "layout");
  return ok({ userId, username, temporaryPassword, expiresAt: issued.data.expiresAt, employeeId, personName: p.full_name, loginUrl: loginUrl("employee") },
    p.status === "inactive" ? "Sign-in created, turned off until you turn it on." : "Sign-in created.");
}

export async function reissueEmployeeSignIn(userId: string): Promise<ActionResult<IssuedCredential & { loginUrl: string }>> {
  await staff();
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const r = await reissue("employee", userId);
  if (!r.ok) return r;
  revalidatePath("/employees", "layout");
  return ok({ ...r.data, loginUrl: loginUrl("employee") }, r.message);
}

export async function emailEmployeeSetup(userId: string): Promise<ActionResult<{ reference: string | null }>> {
  const access = await staff();
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const supabase = await createClient();
  const { data: person } = await supabase.from("employees").select("full_name, work_email").eq("user_id", userId).maybeSingle();
  const to = (person as { work_email?: string } | null)?.work_email ?? "";
  const r = await emailSetupLink("employee", userId, isUsernameEmail(to) ? "" : to, {
    isDemo: Boolean(access.isDemo), personName: (person as { full_name?: string } | null)?.full_name ?? "there", companyName: access.companyName ?? "Your company",
  });
  revalidatePath("/employees", "layout");
  return r;
}

/** The administrator printed or copied instructions (recorded without any secret). */
export async function recordInstructionsHandoff(userId: string, channel: "print" | "copy"): Promise<void> {
  await staff();
  if (!uuid.safeParse(userId).success) return;
  await (await createClient()).rpc("account_delivery_record", { p_user: userId, p_kind: "employee", p_channel: channel, p_outcome: "prepared", p_reference: "" });
}

async function membership(companyId: string, userId: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("company_memberships").select("role, active, profiles(full_name)").eq("company_id", companyId).eq("user_id", userId).maybeSingle();
  return data as { role: AppRole; active: boolean; profiles: { full_name: string } | null } | null;
}

/**
 * Turn a sign-in off: the person loses access to this company at once (the database refuses their requests), and
 * when the sign-in has no access anywhere else its sessions are blocked in Auth so they stop refreshing. Records,
 * loads, tickets and history are kept.
 */
export async function deactivateEmployeeSignIn(userId: string): Promise<ActionResult> {
  const access = await staff();
  if (!uuid.safeParse(userId).success || userId === access.userId) return fail("You cannot turn off your own sign-in.");
  const m = await membership(access.companyId!, userId);
  if (!m) return fail("Sign-in not found.");
  const supabase = await createClient();
  const off = await supabase.rpc("set_user_access", { p_user_id: userId, p_role: m.role, p_active: false, p_full_name: m.profiles?.full_name || "Person" });
  if (off.error) return fail(dbErrorMessage(off.error));
  await supabase.rpc("account_access_record", { p_user: userId, p_kind: "employee", p_action: "deactivated" });
  const blocked = await blockIfUnused("employee", userId);
  revalidatePath("/employees", "layout");
  return ok(undefined, blocked ? "Sign-in turned off and signed out everywhere. Their records and history are kept." : "Sign-in turned off for this company. Their records and history are kept.");
}

export async function reactivateEmployeeSignIn(userId: string): Promise<ActionResult> {
  const access = await staff();
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const m = await membership(access.companyId!, userId);
  if (!m) return fail("Sign-in not found.");
  const supabase = await createClient();
  const on = await supabase.rpc("set_user_access", { p_user_id: userId, p_role: m.role, p_active: true, p_full_name: m.profiles?.full_name || "Person" });
  if (on.error) return fail(dbErrorMessage(on.error));
  await supabase.rpc("account_access_record", { p_user: userId, p_kind: "employee", p_action: "reactivated" });
  await unblock("employee", userId);
  revalidatePath("/employees", "layout");
  return ok(undefined, "Sign-in turned on again.");
}

export async function accountEvents(userId: string): Promise<Array<{ at: string; event: string; method: string | null; channel: string | null }> | string> {
  await staff();
  if (!uuid.safeParse(userId).success) return "Sign-in not found.";
  const { data, error } = await (await createClient()).rpc("account_events", { p_user: userId, p_kind: "employee" });
  if (error) return error.code === "PGRST202" ? NOT_INSTALLED : dbErrorMessage(error);
  return (data ?? []) as Array<{ at: string; event: string; method: string | null; channel: string | null }>;
}

import "server-only";
import { fail } from "@/lib/action-result";
import { ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { approvalSentMessage, decodeArgs, encodeArgs, formValue } from "@/lib/support-requests";
import { getAccess } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Support change requests (SA2, migration 20261120009200). The actions that change who can sign in or what they may
// do call asSupportRequest first: outside a support visit it returns null and the action carries on; during a visit it
// records the change for an owner (the exact arguments, only the form fields the action reads, and a plain description
// read from the company's own records) and returns the "sent for approval" result. Nothing else happens. An owner's
// approval replays the same action as the owner (src/server/support/execute.ts).

type Line = { label: string; value: string };
type Described = { summary: string; details: Line[] };

interface Spec {
  /** FormData fields the action reads; every other field is dropped before storage. */
  form?: readonly string[];
  describe: (args: unknown[]) => Promise<Described>;
}

const roleLabel = (r: string) => ROLE_LABELS[r as AppRole] ?? (r || "No role");
const yes = (v: string) => v === "on" || v === "true" || v === "1";

async function memberName(userId: unknown): Promise<string> {
  const { data } = await (await createClient()).from("company_memberships").select("profiles(full_name, email)").eq("user_id", String(userId)).maybeSingle();
  const p = (data as { profiles: { full_name: string | null; email: string | null } | null } | null)?.profiles;
  return p?.full_name || p?.email || "a person";
}

async function employeeName(id: unknown): Promise<{ name: string; email: string }> {
  const { data } = await (await createClient()).from("employees").select("full_name, work_email").eq("id", String(id)).maybeSingle();
  const e = data as { full_name: string; work_email: string | null } | null;
  return { name: e?.full_name ?? "a person", email: e?.work_email ?? "" };
}

async function portalName(userId: unknown): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.from("portal_accounts").select("customer_id, contact_id").eq("user_id", String(userId)).maybeSingle();
  const a = data as { customer_id: string; contact_id: string | null } | null;
  if (!a) return "a customer contact";
  const [customer, contact] = await Promise.all([
    customerName(a.customer_id),
    a.contact_id ? supabase.from("customer_contacts").select("name").eq("id", a.contact_id).maybeSingle().then((r) => (r.data as { name: string } | null)?.name ?? "") : Promise.resolve(""),
  ]);
  const who = contact || "a customer contact";
  return customer ? `${who} (${customer})` : who;
}

async function customerName(id: string): Promise<string> {
  if (!id) return "";
  const { data } = await (await createClient()).from("customers").select("name").eq("id", id).maybeSingle();
  return (data as { name: string } | null)?.name ?? "";
}

const lines = (...l: Array<[string, string | undefined | null]>): Line[] => l.filter(([, v]) => v).map(([label, value]) => ({ label, value: String(value) }));

export const REQUEST_SPECS = {
  "people.invite": {
    form: ["email", "full_name", "role"],
    describe: async ([fd]) => ({
      summary: `Invite ${formValue(fd, "full_name") || formValue(fd, "email")} as ${roleLabel(formValue(fd, "role"))}`,
      details: lines(["Name", formValue(fd, "full_name")], ["Email", formValue(fd, "email")], ["Role", roleLabel(formValue(fd, "role"))]),
    }),
  },
  "people.invite_person": {
    describe: async ([employeeId, role]) => {
      const e = await employeeName(employeeId);
      return { summary: `Send ${e.name} a sign-in as ${roleLabel(String(role))}`, details: lines(["Person", e.name], ["Email", e.email], ["Role", roleLabel(String(role))]) };
    },
  },
  "people.access": {
    form: ["full_name", "role", "active"],
    describe: async ([userId, fd]) => {
      const name = await memberName(userId);
      const active = yes(formValue(fd, "active"));
      return {
        summary: `${active ? "Change" : "Turn off"} ${name}'s access${active ? `: ${roleLabel(formValue(fd, "role"))}` : ""}`,
        details: lines(["Person", name], ["Name shown", formValue(fd, "full_name")], ["Role", roleLabel(formValue(fd, "role"))], ["Can sign in", active ? "Yes" : "No"]),
      };
    },
  },
  "people.permission": {
    describe: async ([role, permission, granted]) => {
      const { data } = await (await createClient()).from("permissions").select("description").eq("code", String(permission)).maybeSingle();
      const what = (data as { description: string } | null)?.description ?? String(permission);
      return {
        summary: `${granted ? "Allow" : "No longer allow"} ${roleLabel(String(role))}: ${what}`,
        details: lines(["Role", roleLabel(String(role))], ["Permission", `${what} (${String(permission)})`], ["Change", granted ? "Allow" : "Remove"]),
      };
    },
  },
  "signin.create": {
    form: ["request_key", "employee_id", "full_name", "job_title", "username", "email", "phone", "role", "status", "bases"],
    describe: async ([fd]) => ({
      summary: `Create a sign-in for ${formValue(fd, "full_name")} as ${roleLabel(formValue(fd, "role"))}`,
      details: lines(["Name", formValue(fd, "full_name")], ["Username", formValue(fd, "username")], ["Role", roleLabel(formValue(fd, "role"))],
        ["Email", formValue(fd, "email")], ["Job title", formValue(fd, "job_title")], ["Starts", formValue(fd, "status") === "inactive" ? "Turned off" : "Turned on"]),
    }),
  },
  "signin.reissue": { describe: async ([u]) => { const n = await memberName(u); return { summary: `Give ${n} a new temporary password`, details: lines(["Person", n]) }; } },
  "signin.email": { describe: async ([u]) => { const n = await memberName(u); return { summary: `Email ${n} a link to set their password`, details: lines(["Person", n]) }; } },
  "signin.off": { describe: async ([u]) => { const n = await memberName(u); return { summary: `Turn off ${n}'s sign-in`, details: lines(["Person", n]) }; } },
  "signin.on": { describe: async ([u]) => { const n = await memberName(u); return { summary: `Turn ${n}'s sign-in back on`, details: lines(["Person", n]) }; } },
  "signin.passkeys_remove": { describe: async ([u]) => { const n = await memberName(u); return { summary: `Remove ${n}'s face or fingerprint sign-in (lost or new phone)`, details: lines(["Person", n]) }; } },
  "portal.signin_create": {
    form: ["request_key", "customer", "contact", "contact_name", "contact_email", "username"],
    describe: async ([fd]) => {
      const customer = await customerName(formValue(fd, "customer"));
      const contact = formValue(fd, "contact_name") || "their contact";
      return { summary: `Create a portal sign-in for ${contact}${customer ? ` (${customer})` : ""}`, details: lines(["Customer", customer], ["Contact", formValue(fd, "contact_name")], ["Email", formValue(fd, "contact_email")], ["Username", formValue(fd, "username")]) };
    },
  },
  "portal.signin_reissue": { describe: async ([u]) => { const n = await portalName(u); return { summary: `Give ${n} a new portal password`, details: lines(["Portal sign-in", n]) }; } },
  "portal.signin_email": { describe: async ([u]) => { const n = await portalName(u); return { summary: `Email ${n} a link to set their portal password`, details: lines(["Portal sign-in", n]) }; } },
  "portal.signin_off": { describe: async ([u]) => { const n = await portalName(u); return { summary: `Turn off ${n}'s portal sign-in`, details: lines(["Portal sign-in", n]) }; } },
  "portal.signin_on": { describe: async ([u]) => { const n = await portalName(u); return { summary: `Turn ${n}'s portal sign-in back on`, details: lines(["Portal sign-in", n]) }; } },
  "portal.invite": {
    form: ["customer", "contact", "email"],
    describe: async ([fd]) => {
      const customer = await customerName(formValue(fd, "customer"));
      return { summary: `Invite ${formValue(fd, "email")} to the customer portal${customer ? ` for ${customer}` : ""}`, details: lines(["Customer", customer], ["Email", formValue(fd, "email")]) };
    },
  },
  "portal.revoke": {
    form: ["account"],
    describe: async ([fd]) => {
      const { data } = await (await createClient()).from("portal_accounts").select("user_id").eq("id", formValue(fd, "account")).maybeSingle();
      const n = await portalName((data as { user_id: string } | null)?.user_id ?? "");
      return { summary: `Remove portal access for ${n}`, details: lines(["Portal sign-in", n]) };
    },
  },
  "accountant.invite": {
    form: ["request_key", "full_name", "username", "email", "ends_on", "payroll"],
    describe: async ([fd]) => ({
      summary: `Give accountant ${formValue(fd, "full_name")} access until ${formValue(fd, "ends_on")}`,
      details: lines(["Name", formValue(fd, "full_name")], ["Username", formValue(fd, "username")], ["Email", formValue(fd, "email")], ["Last day", formValue(fd, "ends_on")], ["Payroll", yes(formValue(fd, "payroll")) ? "Can see payroll" : "No payroll"]),
    }),
  },
  "accountant.change": {
    form: ["user_id", "ends_on", "payroll", "end_now"],
    describe: async ([fd]) => {
      const n = await memberName(formValue(fd, "user_id"));
      const endNow = formValue(fd, "end_now") === "1";
      return {
        summary: endNow ? `End accountant ${n}'s access now` : `Change accountant ${n}'s access (until ${formValue(fd, "ends_on")})`,
        details: lines(["Accountant", n], ["Last day", endNow ? "Today (ends now)" : formValue(fd, "ends_on")], ["Payroll", yes(formValue(fd, "payroll")) ? "Can see payroll" : "No payroll"]),
      };
    },
  },
} satisfies Record<string, Spec>;

export type RequestKind = keyof typeof REQUEST_SPECS;

/**
 * The approving owner's check (SA2): rebuild the arguments with only the fields the action reads and describe them
 * again from the company's records. A request whose stored description differs from what it would really do (for
 * example one written directly against the database) is refused. Returns the arguments to run, or null.
 */
export async function verifiedArgs(kind: string, args: unknown[], shown: { summary: string; details: unknown }): Promise<unknown[] | null> {
  const spec: Spec | undefined = (REQUEST_SPECS as Record<string, Spec>)[kind];
  if (!spec) return null;
  const clean = decodeArgs(encodeArgs(args, spec.form ?? []));
  if (!clean) return null;
  const now = await spec.describe(clean);
  const same = now.summary.trim().slice(0, 300) === shown.summary && JSON.stringify(now.details.slice(0, 20)) === JSON.stringify(shown.details ?? []);
  return same ? clean : null;
}

/**
 * Outside a support visit: null (the action carries on). During one: the change is recorded for an owner's approval and
 * the "sent for approval" result is returned; the action must return it and do nothing else.
 */
export async function asSupportRequest(kind: RequestKind, args: unknown[]): Promise<{ ok: false; error: string } | null> {
  const access = await getAccess();
  if (!access?.support) return null;
  const spec: Spec = REQUEST_SPECS[kind];
  const encoded = encodeArgs(args, spec.form ?? []);
  if (!encoded) return fail("This change cannot be sent for approval. Ask an owner of the company to make it.");
  const { summary, details } = await spec.describe(args);
  const { error } = await (await createClient()).rpc("support_change_request", {
    p_kind: kind, p_payload: encoded, p_summary: summary.slice(0, 300), p_details: details.slice(0, 20), p_note: "",
  });
  if (error) {
    if (error.code === "PGRST202") return fail("Taviron support cannot change who can sign in to the company. Ask an owner of the company.");
    return fail(dbErrorMessage(error));
  }
  return fail(approvalSentMessage(summary));
}

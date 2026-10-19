import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SignInWizard } from "@/components/accounts/sign-in-wizard";
import { ROLE_PRESETS } from "@/lib/accounts";
import { can, ROLE_LABELS, ROLES, type AppRole } from "@/lib/permissions";
import { uuid } from "@/lib/schemas/common";
import { isUsernameEmail } from "@/lib/usernames";
import { requirePagePermission } from "@/server/auth";
import { emailServerStatus } from "@/server/accounts";
import { listBases } from "@/server/data/bases";
import { adminAvailable } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Add a person with a sign-in" };

/**
 * Create a username sign-in (docs/ACCOUNT_PROVISIONING.md): details → review role, permissions and bases → create →
 * print, copy or email the instructions. ?employee=<id> starts from an existing person without a sign-in.
 */
export default async function NewSignInPage({ searchParams }: { searchParams: Promise<{ employee?: string }> }) {
  const access = await requirePagePermission("users.manage");
  const sp = await searchParams;
  const supabase = await createClient();
  const canEditPeople = can(access, "employees.edit");
  const [{ data: perms }, { data: grants }, bases] = await Promise.all([
    supabase.from("permissions").select("code, category, description").order("category").order("code"),
    supabase.from("role_permissions").select("role, permission"),
    listBases(),
  ]);
  const byRole: Record<string, string[]> = {};
  const describe = new Map(((perms ?? []) as Array<{ code: string; description: string }>).map((p) => [p.code, p.description]));
  for (const g of (grants ?? []) as Array<{ role: string; permission: string }>) (byRole[g.role] ??= []).push(describe.get(g.permission) || g.permission);
  const roles = ROLES.filter((r) => r !== "owner" || access.role === "owner").map((r) => ({ role: r as AppRole, label: ROLE_LABELS[r], permissions: (byRole[r] ?? []).sort() }));

  type Prefill = { id: string; full_name: string; job_title: string; work_email: string; work_phone: string };
  let employee: Prefill | null = null;
  if (sp.employee && uuid.safeParse(sp.employee).success) {
    const { data } = await supabase.from("employees").select("id, full_name, job_title, work_email, work_phone, user_id").eq("id", sp.employee).maybeSingle();
    const e = data as (Prefill & { user_id: string | null }) | null;
    if (e && !e.user_id) employee = { id: e.id, full_name: e.full_name, job_title: e.job_title ?? "", work_email: isUsernameEmail(e.work_email) ? "" : (e.work_email ?? ""), work_phone: e.work_phone ?? "" };
  }
  const blocked = access.isDemo
    ? "Demo companies do not create sign-ins: nothing real is created from a demo. The rest of People works as usual."
    : !canEditPeople
      ? "Creating a sign-in also creates the person record, which needs permission to edit people."
      : !adminAvailable()
        ? "Creating sign-ins needs SUPABASE_SERVICE_ROLE_KEY on the server. Ask the Taviron team to configure it."
        : null;
  const mail = emailServerStatus(Boolean(access.isDemo));

  return (
    <>
      <PageHeader
        title="Add a person with a sign-in"
        crumbs={[{ label: "People", href: "/employees" }, { label: "Add with sign-in" }]}
        description="For drivers, mechanics and anyone without a company email: they sign in with a username. You print, copy or email their first-time instructions; they choose their own password."
      />
      {blocked ? (
        <Notice tone="warning">{blocked} <Link href="/employees" className="font-semibold underline">Back to People</Link></Notice>
      ) : (
        <SignInWizard
          presets={ROLE_PRESETS}
          roles={roles}
          bases={(bases ?? []).filter((b) => b.active).map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))}
          employee={employee}
          companyName={access.companyName ?? "Your company"}
          emailConfigured={mail.configured}
          emailReason={mail.reason}
        />
      )}
    </>
  );
}

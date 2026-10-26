import Link from "next/link";
import { Plus } from "lucide-react";
import { UsersPanel, type UserRow } from "@/components/settings/settings-client";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { signInStatus } from "@/lib/accounts";
import { accountStates, type AccountState } from "@/server/accounts";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { DEPARTMENTS, EMPLOYEE_STATUSES, type EmployeeStatus } from "@/lib/employees";
import { cn } from "@/lib/cn";
import { can, ROLE_LABELS } from "@/lib/permissions";
import { avatarUrl, employeePhotoSrc } from "@/lib/people/avatars";
import { requirePagePermission } from "@/server/auth";
import { listEmployees, photoVersions } from "@/server/data/employees";
import { listSignIns } from "@/server/data/people";
import { pageParam, PAGE_SIZE } from "@/server/data/search";
import { adminAvailable } from "@/server/supabase/admin";

export const metadata = { title: "People" };

type Search = { q?: string; status?: string; department?: string; kind?: string; page?: string; view?: string };

const STATUS_TONE: Record<EmployeeStatus, "green" | "amber" | "gray"> = { active: "green", on_leave: "amber", inactive: "gray", terminated: "gray" };

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("employees.view");
  const sp = await searchParams;
  const manageUsers = can(access, "users.manage");
  const view = sp.view === "access" && manageUsers ? "access" : "directory";
  const header = (
    <>
      <PageHeader
        title="People"
        description="Everyone who works for the company. People who use Taviron have a sign-in and a role."
        actions={can(access, "employees.edit") && (
          <div className="flex flex-wrap gap-2">
            {manageUsers && !access.isDemo ? <ButtonLink href="/employees/new-sign-in" variant="secondary">Add with Username Sign-in</ButtonLink> : null}
            <ButtonLink href="/employees/new" icon={<Plus className="size-4" />}>Add person</ButtonLink>
          </div>
        )}
      />
      {manageUsers && (
        <nav aria-label="People views" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
          {[{ key: "directory", label: "Directory", href: "/employees" }, { key: "access", label: "Sign-ins & roles", href: "/employees?view=access" }].map((t) => (
            <Link key={t.key} href={t.href} aria-current={view === t.key ? "page" : undefined}
              className={cn("flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-150", view === t.key ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>
              <span className="pill-text">{t.label}</span>
            </Link>
          ))}
        </nav>
      )}
    </>
  );
  if (view === "access") {
    const users = await listSignIns(access.companyId!);
    return (
      <>
        {header}
        <Card><UsersPanel users={users} currentUserId={access.userId} inviteAvailable={adminAvailable()} isOwner={access.role === "owner"} /></Card>
      </>
    );
  }
  const page = pageParam(sp.page);
  const { rows, total } = await listEmployees({ q: sp.q, status: sp.status, department: sp.department, kind: sp.kind, page });
  const [photos, signIns, accounts] = await Promise.all([
    photoVersions(rows.map((r) => r.user_id)),
    manageUsers ? listSignIns(access.companyId!) : Promise.resolve([]),
    manageUsers ? accountStates("employee") : Promise.resolve(null),
  ]);
  const signInOf = new Map(signIns.map((u) => [u.id, u]));
  const filtered = Boolean(sp.q || sp.department || sp.kind || (sp.status && sp.status !== "current"));

  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const k of ["q", "status", "department", "kind"] as const) if (sp[k]) params.set(k, sp[k]!);
    params.set("page", String(p));
    return `/employees?${params}`;
  };

  return (
    <>
      {header}
      <Card>
        <FilterBar action="/employees" query={sp.q} placeholder="Search name, title, email, phone…" clearHref="/employees">
          <FilterSelect name="status" label="Status" value={sp.status ?? "current"} options={[
            { value: "current", label: "Active and on leave" },
            ...Object.entries(EMPLOYEE_STATUSES).map(([value, label]) => ({ value, label })),
            { value: "all", label: "All" },
          ]} />
          <FilterSelect name="department" label="Department" value={sp.department ?? ""} options={[
            { value: "", label: "All departments" },
            ...Object.entries(DEPARTMENTS).map(([value, label]) => ({ value, label })),
          ]} />
          <FilterSelect name="kind" label="Show" value={sp.kind ?? ""} options={[
            { value: "", label: "Everyone" },
            { value: "drivers", label: "Drivers" },
            { value: "logins", label: "With a sign-in" },
          ]} />
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No one matches these filters" : "No people yet"}
            description={filtered ? "Try a different search or clear the filters." : "Add the people who work for the company. People who use Taviron get a sign-in when you add them."}
            action={!filtered && can(access, "employees.edit") ? <ButtonLink href="/employees/new">Add person</ButtonLink> : undefined}
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Person</Th>
                    <Th className="hidden md:table-cell">Department</Th>
                    <Th className="hidden lg:table-cell">Contact</Th>
                    <Th className="hidden sm:table-cell">Sign-in</Th>
                    <Th className="hidden xl:table-cell">Driver</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <Tr key={e.id}>
                      <Td>
                        <div className="flex items-center gap-3">
                          <Avatar name={e.full_name} src={employeePhotoSrc(e.user_id, photos)} fallbackSrc={avatarUrl(e.avatar_key)} size={36} />
                          <div className="min-w-0">
                            <Link href={`/employees/${e.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{e.full_name}</Link>
                            <div className="text-sm text-muted">{e.job_title || "No job title"}</div>
                          </div>
                        </div>
                      </Td>
                      <Td className="hidden md:table-cell">{DEPARTMENTS[e.department]}</Td>
                      <Td className="hidden text-sm lg:table-cell">
                        <div className="break-all">{e.work_email || "—"}</div>
                        <div className="whitespace-nowrap text-muted">{e.work_phone}</div>
                      </Td>
                      <Td className="hidden text-sm sm:table-cell">
                        <SignIn userId={e.user_id} member={e.user_id ? signInOf.get(e.user_id) : undefined} account={e.user_id ? accounts?.get(e.user_id) : undefined} />
                      </Td>
                      <Td className="hidden xl:table-cell">
                        {e.driver_id ? (e.primary_truck ? <span>Truck <strong className="tabular">{e.primary_truck}</strong></span> : <span className="text-muted">No primary truck</span>) : <span className="text-muted">—</span>}
                      </Td>
                      <Td><Badge tone={STATUS_TONE[e.status]}>{EMPLOYEE_STATUSES[e.status]}</Badge></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
          </>
        )}
      </Card>
    </>
  );
}

/** Sign-in state: role and whether it is on (with users.manage), or just whether the person signs in. */
function SignIn({ userId, member, account }: { userId: string | null; member?: UserRow; account?: AccountState }) {
  if (!userId) return <span className="text-muted">No sign-in</span>;
  if (!member) return <span>Signs in</span>;
  if (!member.active) return <span className="text-muted">Sign-in turned off</span>;
  const role = <span>{member.role ? ROLE_LABELS[member.role] : "No role"}</span>;
  if (!account) return role;
  // Username sign-ins also show where setup stands (20261120001200).
  const st = signInStatus({ status: account.status, expired: account.expired, active: member.active, banned: account.banned, lastSignInAt: account.last_sign_in_at, completedAt: account.completed_at });
  return <span className="flex flex-wrap items-center gap-1.5">{role}<Badge tone={st.tone}>{st.label}</Badge></span>;
}

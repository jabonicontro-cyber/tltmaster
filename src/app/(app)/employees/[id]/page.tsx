import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock, Pencil } from "lucide-react";
import { CompensationForm } from "@/components/employees/compensation-form";
import { EmployeeLoginLink } from "@/components/employees/login-link";
import { PrimaryTruckPicker } from "@/components/employees/primary-truck";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/dates";
import { DEPARTMENTS, EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, formatPay } from "@/lib/employees";
import { QUALIFICATION_SHORT } from "@/lib/fleet/labels";
import { can, ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { avatarUrl, employeePhotoSrc } from "@/lib/people/avatars";
import { uuid } from "@/lib/schemas/common";
import { requirePagePermission } from "@/server/auth";
import { getEmployee, linkableLogins, photoVersions } from "@/server/data/employees";

export const metadata = { title: "Employee" };

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="font-medium break-words">{children || "—"}</dd>
    </div>
  );
}

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("employees.view");
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const showPay = can(access, "employees.compensation");
  const assign = can(access, "fleet.assign");
  const detail = await getEmployee(id, { compensation: showPay, trucks: assign });
  if (!detail) notFound();
  const { employee: e, driver, compensation, role } = detail;
  const photos = await photoVersions([e.user_id]);
  // Linking needs employees.edit, and reading the company's logins needs users.manage (owners by default).
  const canLink = can(access, "employees.edit") && can(access, "users.manage");
  const candidates = canLink && !e.user_id ? await linkableLogins(access.companyId!) : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={e.full_name}
        crumbs={[{ label: "Employees", href: "/employees" }, { label: e.full_name }]}
        badges={<Badge tone={e.status === "active" ? "green" : e.status === "on_leave" ? "amber" : "gray"}>{EMPLOYEE_STATUSES[e.status]}</Badge>}
        actions={can(access, "employees.edit") && <ButtonLink href={`/employees/${id}/edit`} variant="secondary" icon={<Pencil className="size-4" />}>Edit</ButtonLink>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <div className="flex items-center gap-4 p-4 sm:p-5">
              <Avatar name={e.full_name} src={employeePhotoSrc(e.user_id, photos)} fallbackSrc={avatarUrl(e.avatar_key)} size={64} />
              <div className="min-w-0">
                <p className="text-lg font-semibold">{e.job_title || "No job title"}</p>
                <p className="text-sm text-muted">{DEPARTMENTS[e.department]} · {EMPLOYMENT_TYPES[e.employment_type]}</p>
              </div>
            </div>
            <dl className="grid gap-x-6 gap-y-3 border-t border-line px-4 py-4 sm:grid-cols-2 sm:px-5">
              <Item label="Work email">{e.work_email}</Item>
              <Item label="Work phone">{e.work_phone}</Item>
              <Item label="Hire date">{e.hire_date ? formatDate(e.hire_date) : ""}</Item>
              <Item label="Last day">{e.end_date ? formatDate(e.end_date) : ""}</Item>
              <Item label="Emergency contact">{[e.emergency_contact_name, e.emergency_contact_phone].filter(Boolean).join(" · ")}</Item>
            </dl>
            {e.notes && <p className="border-t border-line px-4 py-4 text-sm whitespace-pre-line sm:px-5">{e.notes}</p>}
          </Card>

          {driver && (
            <Card>
              <CardHeader title="Driver" description="Qualifications and the truck this driver normally uses. Dispatch checks qualifications before every assignment." />
              <div className="space-y-4 px-4 pb-5 sm:px-5">
                {assign ? (
                  <PrimaryTruckPicker employeeId={id} driverId={driver.id} current={driver.primaryTruck?.id ?? null} trucks={detail.trucks} />
                ) : (
                  <p>Primary truck: <strong>{driver.primaryTruck?.unit ?? "Unassigned"}</strong></p>
                )}
                {driver.qualifications.length === 0 ? (
                  <p className="text-sm text-muted">No qualifications recorded. Add them on the driver record.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-md border border-line" aria-label="Qualifications">
                    {driver.qualifications.map((q) => {
                      const expired = q.expires_on !== null && q.expires_on < today;
                      return (
                        <li key={q.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                          <span className="font-semibold">{QUALIFICATION_SHORT[q.kind as keyof typeof QUALIFICATION_SHORT] ?? q.kind}{q.cdl_class ? ` class ${q.cdl_class}` : ""}</span>
                          <span className="text-muted">{q.expires_on ? `expires ${formatDate(q.expires_on)}` : "no expiry recorded"}</span>
                          {expired ? <Badge tone="red">Expired</Badge> : q.verified_at ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Not verified</Badge>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <Link href={`/fleet/drivers/${driver.id}`} className="text-sm font-medium text-brand-fg hover:underline">Open the driver record</Link>
              </div>
            </Card>
          )}

          {showPay && (
            <Card>
              <CardHeader title="Pay (confidential)" description="Only people with the confidential pay permission see this section. Amounts are never written to the audit log." />
              <div className="px-4 pb-5 sm:px-5">
                {compensation && <p className="mb-4 font-semibold">{formatPay(compensation)}{compensation.effective_date ? <span className="font-normal text-muted"> · from {formatDate(compensation.effective_date)}</span> : null}</p>}
                <CompensationForm
                  employeeId={id}
                  initial={{
                    pay_type: compensation?.pay_type ?? "hourly",
                    rate: compensation?.rate_cents != null ? (compensation.rate_cents / 100).toFixed(2) : "",
                    rate_percent: compensation?.rate_percent != null ? String(compensation.rate_percent) : "",
                    effective_date: compensation?.effective_date ?? "",
                    notes: compensation?.notes ?? "",
                  }}
                />
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader title="Taviron access" />
          <div className="space-y-2 px-4 pb-5 text-sm sm:px-5">
            {!e.user_id ? (
              <>
                <p className="text-muted">No login linked. If the person already has a Taviron login, link it here; otherwise invite them from Settings → Users first.</p>
                {canLink ? <EmployeeLoginLink employeeId={e.id} linked={false} candidates={candidates} /> : <p className="text-muted">An owner can link a login.</p>}
              </>
            ) : (
              <>
                <p>Has a login{role ? <> · role <strong>{ROLE_LABELS[role as AppRole] ?? role}</strong></> : null}.</p>
                <p className="flex items-center gap-1.5 text-muted"><Lock className="size-4" aria-hidden /> Roles and access are changed in Settings → Users{can(access, "users.manage") ? "" : " by an administrator"}.</p>
                {can(access, "users.manage") && <Link href="/settings?tab=users" className="font-medium text-brand-fg hover:underline">Open Settings → Users</Link>}
                {canLink && <EmployeeLoginLink employeeId={e.id} linked candidates={[]} />}
              </>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

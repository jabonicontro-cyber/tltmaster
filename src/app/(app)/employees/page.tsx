import Link from "next/link";
import { Plus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { DEPARTMENTS, EMPLOYEE_STATUSES, type EmployeeStatus } from "@/lib/employees";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listEmployees } from "@/server/data/employees";
import { pageParam, PAGE_SIZE } from "@/server/data/search";

export const metadata = { title: "Employees" };

type Search = { q?: string; status?: string; department?: string; kind?: string; page?: string };

const STATUS_TONE: Record<EmployeeStatus, "green" | "amber" | "gray"> = { active: "green", on_leave: "amber", inactive: "gray", terminated: "gray" };

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("employees.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const { rows, total } = await listEmployees({ q: sp.q, status: sp.status, department: sp.department, kind: sp.kind, page });
  const filtered = Boolean(sp.q || sp.department || sp.kind || (sp.status && sp.status !== "current"));

  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const k of ["q", "status", "department", "kind"] as const) if (sp[k]) params.set(k, sp[k]!);
    params.set("page", String(p));
    return `/employees?${params}`;
  };

  return (
    <>
      <PageHeader
        title="Employees"
        description="Everyone who works for the company — with or without a Taviron login — their employment details and, for drivers, qualifications and primary truck."
        actions={can(access, "employees.edit") && <ButtonLink href="/employees/new" icon={<Plus className="size-4" />}>Add employee</ButtonLink>}
      />
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
            { value: "logins", label: "With a Taviron login" },
          ]} />
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No employees match these filters" : "No employees yet"}
            description={filtered ? "Try a different search or clear the filters." : "Add the people who work for the company. A record does not create a login; invite people from Settings → Users when they need one."}
            action={!filtered && can(access, "employees.edit") ? <ButtonLink href="/employees/new">Add employee</ButtonLink> : undefined}
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Employee</Th>
                    <Th className="hidden md:table-cell">Department</Th>
                    <Th className="hidden lg:table-cell">Contact</Th>
                    <Th className="hidden sm:table-cell">Driver</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <Tr key={e.id}>
                      <Td>
                        <div className="flex items-center gap-3">
                          <Avatar name={e.full_name} src={e.user_id ? `/people/photo/${e.user_id}` : ""} size={36} />
                          <div className="min-w-0">
                            <Link href={`/employees/${e.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{e.full_name}</Link>
                            <div className="text-sm text-muted">{e.job_title || "No job title"}{e.user_id ? " · has a login" : ""}</div>
                          </div>
                        </div>
                      </Td>
                      <Td className="hidden md:table-cell">{DEPARTMENTS[e.department]}</Td>
                      <Td className="hidden text-sm lg:table-cell">
                        <div className="break-all">{e.work_email || "—"}</div>
                        <div className="whitespace-nowrap text-muted">{e.work_phone}</div>
                      </Td>
                      <Td className="hidden sm:table-cell">
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

import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmployeeForm } from "@/components/employees/employee-form";
import { uuid } from "@/lib/schemas/common";
import { requirePagePermission } from "@/server/auth";
import { getEmployee } from "@/server/data/employees";
import { saveEmployee } from "../../actions";

export const metadata = { title: "Edit employee" };

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("employees.edit");
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const detail = await getEmployee(id, { compensation: false, trucks: false });
  if (!detail) notFound();
  const e = detail.employee;
  return (
    <>
      <PageHeader title={`Edit ${e.full_name}`} crumbs={[{ label: "Employees", href: "/employees" }, { label: e.full_name, href: `/employees/${id}` }, { label: "Edit" }]} />
      <Card className="p-4 sm:p-6">
        <EmployeeForm
          initial={{
            full_name: e.full_name, job_title: e.job_title, department: e.department, employment_type: e.employment_type, status: e.status,
            hire_date: e.hire_date ?? "", end_date: e.end_date ?? "", work_email: e.work_email, work_phone: e.work_phone,
            emergency_contact_name: e.emergency_contact_name, emergency_contact_phone: e.emergency_contact_phone, notes: e.notes,
          }}
          action={saveEmployee.bind(null, id)}
          cancelHref={`/employees/${id}`}
          submitLabel="Save"
        />
      </Card>
    </>
  );
}

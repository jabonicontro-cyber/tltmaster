import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EMPTY_EMPLOYEE, EmployeeForm } from "@/components/employees/employee-form";
import { requirePagePermission } from "@/server/auth";
import { saveEmployee } from "../actions";

export const metadata = { title: "Add employee" };

export default async function NewEmployeePage() {
  await requirePagePermission("employees.edit");
  return (
    <>
      <PageHeader title="Add employee" crumbs={[{ label: "Employees", href: "/employees" }, { label: "Add" }]} description="An employee record is not a login. Invite people who need Taviron from Settings → Users." />
      <Card className="p-4 sm:p-6">
        <EmployeeForm initial={EMPTY_EMPLOYEE} action={saveEmployee.bind(null, null)} cancelHref="/employees" submitLabel="Add employee" />
      </Card>
    </>
  );
}

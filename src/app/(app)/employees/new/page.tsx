import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EMPTY_EMPLOYEE, EmployeeForm } from "@/components/employees/employee-form";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { saveEmployee } from "../actions";

export const metadata = { title: "Add person" };

export default async function NewEmployeePage() {
  const access = await requirePagePermission("employees.edit");
  const manageUsers = can(access, "users.manage");
  return (
    <>
      <PageHeader
        title="Add person"
        crumbs={[{ label: "People", href: "/employees" }, { label: "Add" }]}
        description={manageUsers ? "Everyone who works for the company. People who use Taviron also get a sign-in." : "Everyone who works for the company. Someone who manages users can give them a sign-in."}
      />
      <Card className="p-4 sm:p-6">
        <EmployeeForm initial={EMPTY_EMPLOYEE} action={saveEmployee.bind(null, null)} cancelHref="/employees" submitLabel="Add person" signIn={manageUsers ? { isOwner: access.role === "owner" } : undefined} />
      </Card>
    </>
  );
}

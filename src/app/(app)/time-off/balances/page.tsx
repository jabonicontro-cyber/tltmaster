import { AdjustForm, BankForm } from "@/components/time-off/pto-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { EMPLOYMENT_TYPES, formatHours, LEDGER_KINDS } from "@/lib/pto";
import { TIME_OFF_CATEGORIES } from "@/lib/time-off";
import { requirePagePermission } from "@/server/auth";
import { balanceOverview, ledger, listBanks } from "@/server/data/pto";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";
import { currentEmployees, employeeNames } from "@/server/data/time-off";

export const metadata = { title: "Time-off banks and balances" };

export default async function BalancesPage() {
  await requirePagePermission("time_off.balances");
  const banks = await listBanks();
  const crumbs = [{ label: "Time off", href: "/time-off" }, { label: "Banks and balances" }];
  if (banks === null) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Banks and balances" />
        <Notice tone="warning" title="Not available yet">Time-off balances need a database update that has not been installed yet.</Notice>
      </>
    );
  }
  const active = banks.filter((b) => b.active);
  const [overview, history, employees, names, people, { timezone }] = await Promise.all([
    active.length ? balanceOverview() : Promise.resolve([]),
    ledger({ limit: 50 }),
    currentEmployees(),
    employeeNames(),
    getUserNames(),
    businessToday(),
  ]);
  const bankName = new Map(banks.map((b) => [b.id, b.name]));

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Banks and balances"
        description="Set up the banks your time off draws from, grant hours and adjust balances. Requests on a bank are refused when they exceed the available hours."
      />
      <Notice title="Coming soon">
        Automatic accruals (annual grants on a date, hours worked, per pay period), carryover and expiration, and approval
        chains. Until then, hours are added by grants and adjustments here, and every change is kept in the history.
      </Notice>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Banks" description="A kind of time off draws from one bank at most. Kinds without a bank are not checked against a balance." />
          {banks.length === 0 ? (
            <EmptyState title="No banks yet" description="Create a bank below to start tracking balances." />
          ) : (
            <ul className="divide-y divide-line">
              {banks.map((b) => (
                <li key={b.id} className="px-4 py-3 sm:px-5">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      <span className="font-semibold">{b.name}</span>
                      {!b.active && <Badge tone="gray">Inactive</Badge>}
                      <span className="text-sm text-muted">
                        {b.categories.map((c) => TIME_OFF_CATEGORIES[c]).join(", ")} · {b.employment_types.map((t) => EMPLOYMENT_TYPES[t]).join(", ")}
                        {b.waiting_days ? ` · ${b.waiting_days}-day waiting period` : ""}
                      </span>
                    </summary>
                    <div className="mt-3"><BankForm bank={b} /></div>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <CardBody className="border-t border-line">
            <h3 className="mb-3 text-sm font-semibold">New bank</h3>
            <BankForm />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Grant or adjust hours" description="Grants add hours; adjustments correct a balance and need a reason. A balance never goes below zero." />
          <CardBody>
            {active.length === 0 ? <p className="text-sm text-muted">Create an active bank first.</p> : <AdjustForm employees={employees} banks={active} />}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="Balances" description="Current employees who can use each bank. Available = balance minus pending requests." />
        {overview.length === 0 ? (
          <EmptyState title="No balances to show" description={active.length ? "No current employee can use the active banks." : "Create a bank to see balances."} />
        ) : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Employee</Th><Th>Bank</Th><Th className="text-right">Balance</Th><Th className="hidden text-right sm:table-cell">Pending</Th><Th className="text-right">Available</Th></tr></thead>
              <tbody>
                {overview.map((r) => (
                  <Tr key={`${r.employee_id}-${r.bank_id}`}>
                    <Td className="font-medium">{r.employee_name}{!r.eligible && <span className="ml-2 text-xs text-muted">(not eligible)</span>}</Td>
                    <Td>{r.bank_name}</Td>
                    <Td className="text-right tabular">{formatHours(r.balance)}</Td>
                    <Td className="hidden text-right tabular sm:table-cell">{formatHours(r.pending)}</Td>
                    <Td className="text-right font-semibold tabular">{formatHours(r.available)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <Card className="mt-5">
        <CardHeader title="Recent history" description="Every grant, adjustment, use and return, newest first. Entries are never edited or deleted." />
        {history.length === 0 ? (
          <EmptyState title="No entries yet" />
        ) : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Employee</Th><Th>Entry</Th><Th className="text-right">Hours</Th><Th className="hidden md:table-cell">Note</Th><Th className="hidden sm:table-cell">By</Th></tr></thead>
              <tbody>
                {history.map((e) => (
                  <Tr key={e.id}>
                    <Td className="font-medium">{names.get(e.employee_id)?.name ?? "Employee"}<span className="block text-xs text-muted">{bankName.get(e.bank_id)} · {formatDate(e.effective_on)}</span></Td>
                    <Td>{LEDGER_KINDS[e.kind]}</Td>
                    <Td className="text-right tabular">{e.hours > 0 ? "+" : ""}{formatHours(e.hours)}</Td>
                    <Td className="hidden md:table-cell">{e.note || "—"}</Td>
                    <Td className="hidden text-xs text-muted sm:table-cell">{e.created_by ? people[e.created_by] ?? "Former member" : "—"}<span className="block">{formatDateTime(e.created_at, timezone)}</span></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

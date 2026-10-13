import { AdjustForm, BankForm, EndPolicyButton, HoursForm, PolicyForm, RunAccrualsButton } from "@/components/time-off/pto-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { describePolicy, EMPLOYMENT_TYPES, formatHours, LEDGER_KINDS } from "@/lib/pto";
import { TIME_OFF_CATEGORIES } from "@/lib/time-off";
import { requirePagePermission } from "@/server/auth";
import { balanceOverview, ledger, listBanks, listPolicies } from "@/server/data/pto";
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
  const [overview, history, employees, names, people, { timezone }, policies] = await Promise.all([
    active.length ? balanceOverview() : Promise.resolve([]),
    ledger({ limit: 50 }),
    currentEmployees(),
    employeeNames(),
    getUserNames(),
    businessToday(),
    listPolicies(),
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
        Approval chains (several approvers in order) and hours worked imported automatically from payroll or ELD
        integrations. Today one approver with the time-off approval permission decides, and hours worked are entered here.
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

      {policies !== null && (
        <Card className="mt-5">
          <CardHeader
            title="Accrual policies"
            description="How each bank earns hours, per employment type. Running accruals posts what is due through today exactly once; nothing runs on its own."
            actions={active.length ? <RunAccrualsButton /> : undefined}
          />
          {policies.length === 0 ? (
            <EmptyState title="No accrual policies" description="Add one below, or keep using grants and adjustments." />
          ) : (
            <ul className="divide-y divide-line" aria-label="Accrual policies">
              {policies.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="font-semibold">{bankName.get(p.bank_id)} · {EMPLOYMENT_TYPES[p.employment_type]}</p>
                    <p className="text-sm text-muted">{describePolicy(p)} · from {formatDate(p.effective_from)}</p>
                  </div>
                  <EndPolicyButton id={p.id} />
                </li>
              ))}
            </ul>
          )}
          {active.length > 0 && (
            <div className="grid gap-5 border-t border-line p-4 sm:p-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div><h3 className="mb-3 text-sm font-semibold">New or replacement policy</h3><PolicyForm banks={active} /></div>
              <div><h3 className="mb-3 text-sm font-semibold">Record hours worked</h3><HoursForm employees={employees} /></div>
            </div>
          )}
        </Card>
      )}

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

import { notFound } from "next/navigation";
import { PrintButton } from "@/components/quotes/print-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { FlashToast } from "@/components/ui/flash-toast";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { RATE_UNIT_LABELS, type RateUnit } from "@/lib/hired-trucks";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import { addSettlementDeduction, removeSettlementDeduction, setSettlementStatus } from "../../actions";

export const metadata = { title: "Hauler settlement" };

const STATUS = { draft: { label: "Draft", tone: "gray" }, approved: { label: "Approved", tone: "blue" }, paid: { label: "Paid", tone: "green" }, void: { label: "Void", tone: "red" } } as const;
const SAVED = {
  created: { text: "Draft created. Add any deductions, then approve it." },
  deducted: { text: "Deduction added." },
  removed: { text: "Deduction removed." },
  approved: { text: "Approved. It can no longer change; mark it paid once you have paid the hauler." },
  paid: { text: "Recorded as paid." },
  void: { text: "Voided. Its jobs can go on a new settlement." },
};

type Settlement = {
  id: string; number: number; hauler_id: string; period_start: string; period_end: string; status: keyof typeof STATUS;
  gross_cents: number; commission_bp: number; commission_cents: number; deductions_cents: number; net_cents: number;
  paid_on: string | null; paid_reference: string; void_reason: string; created_at: string;
};

/**
 * One hauler settlement (B129): the statement to hand the hauler and the steps to approve, record payment or void it.
 * The statement itself prints in light colours (force-light). Taviron moves no money.
 */
export default async function SettlementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; left_out?: string }> }) {
  const access = await requirePagePermission("dispatch.view");
  if (!can(access, "payroll.manage") && !can(access, "billing.view")) notFound();
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("hauler_settlements").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const st = data as Settlement;
  const [hauler, jobs, deductions, { today }] = await Promise.all([
    supabase.from("haulers").select("name, contact_name, phone, email").eq("id", st.hauler_id).maybeSingle(),
    supabase.from("hauler_settlement_jobs").select("id, load_date, label, quantity, rate_unit, rate_cents, amount_cents").eq("settlement_id", id).eq("released", false).order("load_date"),
    supabase.from("hauler_settlement_deductions").select("id, description, amount_cents").eq("settlement_id", id).eq("removed", false).order("created_at"),
    businessToday(),
  ]);
  const h = hauler.data as { name: string; contact_name: string; phone: string; email: string } | null;
  const jobRows = (jobs.data ?? []) as Array<{ id: string; load_date: string; label: string; quantity: number; rate_unit: RateUnit; rate_cents: number; amount_cents: number }>;
  const dedRows = (deductions.data ?? []) as Array<{ id: string; description: string; amount_cents: number }>;
  const company = access.companyName ?? "";
  const manage = can(access, "payroll.manage");
  const draft = st.status === "draft";

  return (
    <>
      <FlashToast messages={SAVED} />
      <PageHeader
        title={`Settlement #${st.number}`}
        crumbs={[{ label: "Hired trucks", href: "/hired-trucks" }, { label: `Settlement #${st.number}` }]}
        badges={<Badge tone={STATUS[st.status].tone}>{STATUS[st.status].label}</Badge>}
        description={`${h?.name ?? "Hauler"} · ${formatDate(st.period_start)} – ${formatDate(st.period_end)}`}
        actions={<div className="flex gap-2 print:hidden"><PrintButton /><ButtonLink href="/hired-trucks" variant="secondary">Hired trucks</ButtonLink></div>}
      />
      {sp.error && <div className="mb-4 print:hidden"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div>}
      {Number(sp.left_out) > 0 && draft && (
        <div className="mb-4 print:hidden"><Notice title={`${sp.left_out} job${Number(sp.left_out) === 1 ? "" : "s"} left out`}>Confirmed jobs in this period without an accepted ticket, or with a ticket in another unit than the offer, are not on this settlement. Check their tickets; they can go on a later one.</Notice></div>
      )}
      {st.status === "void" && <div className="mb-4"><Notice tone="warning" title="Void">{st.void_reason}</Notice></div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
        <article className="force-light rounded-panel border border-line/70 bg-card p-6 text-ink shadow-card" aria-label="Settlement statement">
          <header className="flex flex-wrap justify-between gap-4 border-b border-line pb-4">
            <div>
              <p className="text-sm text-muted">{company}</p>
              <h2 className="text-xl font-semibold">Settlement statement #{st.number}</h2>
              <p className="text-sm text-muted">{formatDate(st.period_start)} – {formatDate(st.period_end)}</p>
            </div>
            <div className="text-right text-sm">
              <p className="font-semibold">{h?.name}</p>
              {h?.contact_name && <p className="text-muted">{h.contact_name}</p>}
              {h?.phone && <p className="text-muted">{h.phone}</p>}
            </div>
          </header>
          <TableWrap className="mt-4 rounded-none border-0">
            <Table aria-label="Jobs">
              <thead><tr><Th>Day</Th><Th>Job</Th><Th align="right">Quantity</Th><Th align="right">Rate</Th><Th align="right">Amount</Th></tr></thead>
              <tbody>
                {jobRows.length === 0 ? (
                  <Tr><Td colSpan={5} className="text-muted">No jobs with accepted tickets in this period.</Td></Tr>
                ) : jobRows.map((j) => (
                  <Tr key={j.id}>
                    <Td className="whitespace-nowrap">{formatDate(j.load_date)}</Td>
                    <Td>{j.label}</Td>
                    <Td align="right" className="tabular">{Number(j.quantity)} {j.rate_unit}{Number(j.quantity) === 1 ? "" : "s"}</Td>
                    <Td align="right" className="tabular">{formatCents(j.rate_cents)} {RATE_UNIT_LABELS[j.rate_unit]}</Td>
                    <Td align="right" className="tabular">{formatCents(Number(j.amount_cents))}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <dl className="mt-4 ml-auto w-full max-w-sm space-y-1 text-[15px]" aria-label="Totals">
            <div className="flex justify-between"><dt>Gross</dt><dd className="tabular">{formatCents(Number(st.gross_cents))}</dd></div>
            <div className="flex justify-between text-muted"><dt>Commission ({st.commission_bp / 100}%)</dt><dd className="tabular">−{formatCents(Number(st.commission_cents))}</dd></div>
            {dedRows.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 text-muted">
                <dt className="min-w-0 truncate">{d.description}</dt>
                <dd className="flex items-center gap-2 tabular">
                  −{formatCents(Number(d.amount_cents))}
                  {manage && draft && (
                    <form action={removeSettlementDeduction} className="print:hidden">
                      <input type="hidden" name="settlement_id" value={st.id} />
                      <input type="hidden" name="deduction_id" value={d.id} />
                      <SubmitButton size="sm" variant="ghost">Remove</SubmitButton>
                    </form>
                  )}
                </dd>
              </div>
            ))}
            <div className="flex justify-between border-t-2 border-strong pt-1 text-lg font-bold"><dt>Net pay</dt><dd className="tabular">{formatCents(Number(st.net_cents))}</dd></div>
          </dl>
          {st.status === "paid" && <p className="mt-4 text-sm">Paid {formatDate(st.paid_on)}{st.paid_reference ? ` · ${st.paid_reference}` : ""}</p>}
        </article>

        {manage && st.status !== "paid" && st.status !== "void" && (
          <div className="space-y-5 print:hidden">
            {draft && (
              <Card>
                <CardHeader title="Add a deduction" description="For example a fuel advance or damage. The hauler sees it on the statement." />
                <CardBody>
                  <form action={addSettlementDeduction} className="space-y-3" aria-label="Add a deduction">
                    <input type="hidden" name="settlement_id" value={st.id} />
                    <Field label="What for" htmlFor="ded-desc"><Input id="ded-desc" name="description" required maxLength={200} placeholder="Fuel advance" /></Field>
                    <Field label="Amount ($)" htmlFor="ded-amount"><Input id="ded-amount" name="amount" inputMode="decimal" required className="max-w-32" /></Field>
                    <SubmitButton variant="secondary">Add deduction</SubmitButton>
                  </form>
                </CardBody>
              </Card>
            )}
            <Card>
              <CardHeader title={draft ? "Approve" : "Record payment"} description={draft ? "Approving locks the statement." : "Once you have paid the hauler (check, ACH…), record it here."} />
              <CardBody className="space-y-4">
                {draft ? (
                  <form action={setSettlementStatus}>
                    <input type="hidden" name="settlement_id" value={st.id} />
                    <input type="hidden" name="status" value="approved" />
                    <SubmitButton disabled={jobRows.length === 0}>Approve</SubmitButton>
                  </form>
                ) : (
                  <form action={setSettlementStatus} className="space-y-3" aria-label="Record payment">
                    <input type="hidden" name="settlement_id" value={st.id} />
                    <input type="hidden" name="status" value="paid" />
                    <Field label="Paid on" htmlFor="paid-on"><DateInput id="paid-on" name="paid_on" defaultValue={today} required /></Field>
                    <Field label="Reference" htmlFor="paid-ref" hint="Check number or transfer reference"><Input id="paid-ref" name="reference" maxLength={80} /></Field>
                    <SubmitButton>Mark paid</SubmitButton>
                  </form>
                )}
                <form action={setSettlementStatus} className="space-y-2 border-t border-line pt-4" aria-label="Void">
                  <input type="hidden" name="settlement_id" value={st.id} />
                  <input type="hidden" name="status" value="void" />
                  <Field label="Reason to void" htmlFor="void-reason"><Input id="void-reason" name="reason" required maxLength={500} /></Field>
                  <SubmitButton variant="ghost">Void settlement</SubmitButton>
                </form>
              </CardBody>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

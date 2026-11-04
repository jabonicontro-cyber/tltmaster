import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { CaseReplyForm, LinkFields } from "@/components/support/case-forms";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { SUPPORT_KINDS, SUPPORT_REOPEN_DAYS, SUPPORT_STATUS_STAFF } from "@/lib/support";
import { requirePagePermission } from "@/server/auth";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";
import { getSupportCase, supportLinkOptions } from "@/server/data/support";
import { updateSupportCase } from "../actions";

export const metadata = { title: "Support Case" };

export default async function SupportCasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const access = await requirePagePermission("customers.view");
  const { id } = await params;
  const sp = await searchParams;
  const c = await getSupportCase(id);
  if (!c) notFound();
  const edit = can(access, "customers.edit");
  const [names, { timezone }, links] = await Promise.all([getUserNames(), businessToday(), edit ? supportLinkOptions(c.customer_id) : Promise.resolve(null)]);
  const who = (m: { author_kind: string; author_id: string | null }) => (m.author_kind === "customer" ? c.customer_name : m.author_id ? names[m.author_id] ?? "Staff" : "Staff");
  return (
    <>
      <p className="mb-2 text-sm"><Link href="/support" className="text-muted hover:text-ink hover:underline">← Support</Link></p>
      <PageHeader title={c.subject} description={`${c.customer_name} · ${SUPPORT_KINDS[c.kind] ?? "Other"} · opened ${formatDateTime(c.created_at, timezone)}${c.from_portal ? " in the portal" : " by the office"}`} />
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div> : null}
      {sp.saved ? <p role="status" className="mb-4 text-sm text-muted">Case updated.</p> : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <ol className="space-y-3" aria-label="Messages">
            {c.messages.map((m) => (
              <li key={m.id} className={cn("max-w-[44rem] rounded-2xl border p-3",
                m.internal ? "border-amber-300 bg-amber-50/70" : m.author_kind === "customer" ? "border-line bg-card" : "ml-auto border-brand/30 bg-brand-light")}>
                <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted">
                  {m.internal && <><Lock className="size-3.5" aria-hidden /> Internal note ·</>} {who(m)} · {formatDateTime(m.created_at, timezone)}
                </p>
                <p className="text-sm whitespace-pre-line text-ink">{m.body}</p>
                {m.files.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
                    {m.files.map((f) => (
                      <li key={f.id}>
                        <a href={`/support/files/${f.id}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2 py-1 text-xs font-medium text-ink hover:border-strong/40">
                          <FileText className="size-3.5" aria-hidden /> {f.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          {edit && (
            <Card>
              <CardBody>
                {c.status === "closed" && <p className="mb-3 text-sm text-muted">Closed {c.closed_at ? formatDateTime(c.closed_at, timezone) : ""}. The customer can reopen it by writing within {SUPPORT_REOPEN_DAYS} days; a reply from you reopens it now.</p>}
                <CaseReplyForm request={c.id} closed={c.status === "closed"} />
              </CardBody>
            </Card>
          )}
        </div>
        <Card className="h-fit">
          <CardHeader title="Case" />
          <CardBody className="space-y-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={c.status === "open" ? "brand" : c.status === "answered" ? "green" : "gray"}>{SUPPORT_STATUS_STAFF[c.status]}</Badge>
              {c.first_reply_at ? <span className="text-muted">First reply {formatDateTime(c.first_reply_at, timezone)}</span> : <span className="text-muted">No reply yet</span>}
            </p>
            <p className="space-x-3">
              {c.order && <Link href={`/orders/${c.order.id}`} className="underline">Order {c.order.number}</Link>}
              {c.ticket && <Link href={`/tickets/${c.ticket.id}`} className="underline">Ticket {c.ticket.number}</Link>}
              {c.invoice && <Link href={`/billing/invoices/${c.invoice.id}`} className="underline">Invoice {c.invoice.number}</Link>}
              <Link href={`/customers/${c.customer_id}`} className="underline">Customer</Link>
            </p>
            {edit && links ? (
              <form action={updateSupportCase} className="space-y-3 border-t border-line pt-3">
                <input type="hidden" name="request" value={c.id} />
                <Field label="Type" htmlFor="case-kind">
                  <Select id="case-kind" name="kind" defaultValue={c.kind}>{Object.entries(SUPPORT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                </Field>
                <Field label="Assigned to" htmlFor="case-assign">
                  <Select id="case-assign" name="assign" defaultValue={c.assigned_to ?? ""}>
                    <option value="">Nobody</option>
                    {Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([uid, n]) => <option key={uid} value={uid}>{n}</option>)}
                  </Select>
                </Field>
                <LinkFields stacked links={links} value={{ order: c.order?.id, ticket: c.ticket?.id, invoice: c.invoice?.id }} />
                <SubmitButton variant="secondary" size="sm">Save</SubmitButton>
              </form>
            ) : (
              <p>Assigned to {c.assigned_to ? names[c.assigned_to] ?? "Former member" : "nobody"}</p>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

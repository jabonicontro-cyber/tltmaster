import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate, formatDateTime } from "@/lib/dates";
import { ACTIVITY_KINDS, ACTIVITY_LABELS, OPEN_STAGES, RELATIONSHIP_LABELS, STAGES, STAGE_LABELS, type Activity, type CrmTask, type CustomerHistory, type Opportunity, type Relationship } from "@/lib/crm/labels";
import { usd } from "@/lib/site/pricing";
import { addTask, logActivity, saveOpportunity, saveRelationship, setTaskStatus } from "@/app/(app)/customers/crm-actions";

type Names = Record<string, string>;
const money = (c: number | null) => (c === null ? "—" : usd(c));
const stageTone = (s: string) => (s === "won" ? "green" : s === "lost" ? "gray" : s === "negotiation" || s === "quoting" ? "blue" : "gray") as "green" | "gray" | "blue";

function PeopleSelect({ id, name, names, value, empty }: { id: string; name: string; names: Names; value?: string | null; empty: string }) {
  return (
    <Select id={id} name={name} defaultValue={value ?? ""}>
      <option value="">{empty}</option>
      {Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([uid, n]) => <option key={uid} value={uid}>{n}</option>)}
    </Select>
  );
}

/** Relationship, account owner and tags. */
export function RelationshipCard({ customerId, relationship, ownerId, tags, names, canEdit }: { customerId: string; relationship: Relationship; ownerId: string | null; tags: string[]; names: Names; canEdit: boolean }) {
  return (
    <section aria-label="Account">
    <Card>
      <span id="crm" className="block scroll-mt-20" />
      <CardHeader title="Account" actions={<Badge tone={relationship === "prospect" ? "amber" : "green"}>{RELATIONSHIP_LABELS[relationship]}</Badge>} />
      <CardBody className="space-y-3 text-sm">
        <p><span className="text-muted">Account owner:</span> {ownerId ? names[ownerId] ?? "Former user" : "Nobody yet"}</p>
        <p className="flex flex-wrap items-center gap-1.5"><span className="text-muted">Tags:</span> {tags.length ? tags.map((t) => <Badge key={t}>{t}</Badge>) : "None"}</p>
        {canEdit && (
          <details>
            <summary className="cursor-pointer font-semibold text-brand-fg">Edit account</summary>
            <form action={saveRelationship} className="mt-3 space-y-3">
              <input type="hidden" name="customer" value={customerId} />
              <Field label="Relationship" htmlFor="relationship">
                <Select id="relationship" name="relationship" defaultValue={relationship}>
                  <option value="prospect">Prospect (not ordering yet)</option>
                  <option value="customer">Customer</option>
                </Select>
              </Field>
              <Field label="Account owner" htmlFor="account_owner_id"><PeopleSelect id="account_owner_id" name="account_owner_id" names={names} value={ownerId} empty="Nobody" /></Field>
              <Field label="Tags" htmlFor="tags" hint="Separated by commas, e.g. quarry, priority."><Input id="tags" name="tags" defaultValue={tags.join(", ")} maxLength={1000} /></Field>
              <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Save account</SubmitButton>
            </form>
          </details>
        )}
      </CardBody>
    </Card>
    </section>
  );
}

/** What the records say about this customer: orders, deliveries, quotes. */
export function HistoryCard({ history, timezone }: { history: CustomerHistory; timezone: string }) {
  const delivered = Object.entries(history.delivered_365d);
  const winRate = history.quotes.decided ? Math.round((history.quotes.accepted / history.quotes.decided) * 100) : null;
  return (
    <Card>
      <CardHeader title="History" description="From this customer's orders, accepted delivery tickets and quotes." />
      <CardBody className="space-y-4 text-sm">
        {history.quiet && <p className="rounded-xl bg-amber-50 px-3 py-2 font-medium text-amber-900">No new order in more than 90 days (last on {formatDate(history.last_order_on!)}).</p>}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <div><dt className="text-xs text-muted">Orders</dt><dd className="text-lg font-semibold tabular">{history.orders}</dd><dd className="text-xs text-muted">{history.open_orders} open</dd></div>
          <div><dt className="text-xs text-muted">Ordered, last 12 months</dt><dd className="text-lg font-semibold tabular">{usd(history.ordered_cents_365d)}</dd><dd className="text-xs text-muted">order totals, not invoices</dd></div>
          <div><dt className="text-xs text-muted">Delivered, last 12 months</dt><dd className="font-semibold tabular">{delivered.length ? delivered.map(([u, q]) => `${Number(q).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${u}`).join(" · ") : "—"}</dd><dd className="text-xs text-muted">{history.accepted_tickets} accepted tickets in all</dd></div>
          <div><dt className="text-xs text-muted">Quotes won</dt><dd className="text-lg font-semibold tabular">{winRate === null ? "—" : `${winRate}%`}</dd><dd className="text-xs text-muted">{history.quotes.accepted} of {history.quotes.decided} decided · {history.quotes.open} open</dd></div>
        </dl>
        {history.recent_orders.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {history.recent_orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
                <Link href={`/orders/${o.id}`} className="font-semibold hover:underline">{o.order_number}</Link>
                <span className="text-muted">{formatDate(o.order_date)}</span>
                <Badge>{o.status.replaceAll("_", " ")}</Badge>
                <span className="ml-auto tabular">{usd(o.total_cents)}</span>
              </li>
            ))}
          </ul>
        )}
        {history.first_order_on && <p className="text-xs text-muted">Customer since their first order on {formatDate(history.first_order_on)}. Times shown in {timezone}.</p>}
      </CardBody>
    </Card>
  );
}

function OpportunityForm({ customerId, o, names }: { customerId: string; o?: Opportunity; names: Names }) {
  const k = o?.id ?? "new";
  return (
    <form action={saveOpportunity} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input type="hidden" name="customer" value={customerId} />
      {o && <input type="hidden" name="opportunity" value={o.id} />}
      {!o && <Field label="What is it" htmlFor={`title-${k}`} className="sm:col-span-2"><Input id={`title-${k}`} name="title" required maxLength={200} placeholder="e.g. Spring gravel for the subdivision" /></Field>}
      <Field label="Stage" htmlFor={`stage-${k}`}>
        <Select id={`stage-${k}`} name="stage" defaultValue={o?.stage ?? "new"}>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</Select>
      </Field>
      <Field label="Value ($)" htmlFor={`value-${k}`} hint="Your estimate; leave empty if unknown."><Input id={`value-${k}`} name="value" inputMode="decimal" defaultValue={o?.value_cents != null ? String(o.value_cents / 100) : ""} /></Field>
      <Field label="Probability (%)" htmlFor={`prob-${k}`}><Input id={`prob-${k}`} name="probability" inputMode="numeric" defaultValue={o?.probability ?? ""} /></Field>
      <Field label="Owner" htmlFor={`owner-${k}`}><PeopleSelect id={`owner-${k}`} name="owner_id" names={names} value={o?.owner_id} empty="Nobody" /></Field>
      <Field label="Follow up on" htmlFor={`follow-${k}`}><DateInput id={`follow-${k}`} name="follow_up_on" defaultValue={o?.follow_up_on ?? ""} /></Field>
      <Field label="Expected close" htmlFor={`close-${k}`}><DateInput id={`close-${k}`} name="expected_close_on" defaultValue={o?.expected_close_on ?? ""} /></Field>
      <Field label="Next action" htmlFor={`next-${k}`} className="sm:col-span-2"><Input id={`next-${k}`} name="next_action" maxLength={300} defaultValue={o?.next_action ?? ""} /></Field>
      <Field label="If lost, why" htmlFor={`lost-${k}`} className="sm:col-span-2"><Input id={`lost-${k}`} name="lost_reason" maxLength={500} defaultValue={o?.lost_reason ?? ""} /></Field>
      <div className="sm:col-span-2"><SubmitButton size="sm" pendingLabel="Saving…">{o ? "Save" : "Add opportunity"}</SubmitButton></div>
    </form>
  );
}

export function OpportunitiesCard({ customerId, opportunities, names, canEdit, today }: { customerId: string; opportunities: Opportunity[]; names: Names; canEdit: boolean; today: string }) {
  return (
    <Card>
      <span id="opportunities" className="block scroll-mt-20" />
      <CardHeader title="Opportunities" description="Work you are trying to win from this customer." actions={<Link href="/customers/pipeline" className="text-sm font-semibold text-brand-fg hover:underline">Pipeline</Link>} />
      {opportunities.length === 0 ? (
        <p className="px-5 py-3 text-sm text-muted sm:px-6">No opportunities yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {opportunities.map((o) => {
            const late = o.follow_up_on && o.follow_up_on < today && OPEN_STAGES.includes(o.stage);
            return (
              <li key={o.id} className="space-y-1 px-5 py-3 text-sm sm:px-6">
                <p className="flex flex-wrap items-center gap-2"><span className="font-semibold">{o.title}</span><Badge tone={stageTone(o.stage)}>{STAGE_LABELS[o.stage]}</Badge><span className="ml-auto tabular">{money(o.value_cents)}{o.probability !== null ? ` · ${o.probability}%` : ""}</span></p>
                <p className="text-muted">
                  {o.owner_id ? `${names[o.owner_id] ?? "Former user"} · ` : ""}
                  {o.follow_up_on ? <span className={late ? "font-semibold text-critical" : ""}>Follow up {formatDate(o.follow_up_on)}{late ? " (overdue)" : ""}</span> : "No follow-up date"}
                  {o.next_action ? ` · Next: ${o.next_action}` : ""}
                  {o.stage === "lost" && o.lost_reason ? ` · Lost: ${o.lost_reason}` : ""}
                </p>
                {canEdit && (
                  <details>
                    <summary className="cursor-pointer text-xs font-semibold text-brand-fg">Update</summary>
                    <div className="mt-2"><OpportunityForm customerId={customerId} o={o} names={names} /></div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <CardBody className="border-t border-line">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-brand-fg">New opportunity</summary>
            <div className="mt-3"><OpportunityForm customerId={customerId} names={names} /></div>
          </details>
        </CardBody>
      )}
    </Card>
  );
}

export function TasksCard({ customerId, tasks, names, canEdit, today }: { customerId: string; tasks: CrmTask[]; names: Names; canEdit: boolean; today: string }) {
  const open = tasks.filter((t) => t.status === "open");
  const closed = tasks.filter((t) => t.status !== "open").slice(0, 5);
  return (
    <Card>
      <span id="tasks" className="block scroll-mt-20" />
      <CardHeader title="Follow-ups" description={`${open.length} open`} />
      <ul className="divide-y divide-line" aria-label="Follow-ups">
        {open.length === 0 && <li className="px-5 py-3 text-sm text-muted sm:px-6">Nothing to follow up.</li>}
        {open.map((t) => {
          const late = t.due_on !== null && t.due_on < today;
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
              <span className="min-w-0 flex-[1_1_12rem]"><span className="font-medium">{t.title}</span>
                <span className="block text-xs text-muted">{t.assigned_to ? names[t.assigned_to] ?? "Former user" : "Unassigned"} · {t.due_on ? <span className={late ? "font-semibold text-critical" : ""}>due {formatDate(t.due_on)}{late ? " (overdue)" : ""}</span> : "no due date"}</span>
              </span>
              {canEdit && (
                <span className="flex gap-1.5">
                  {(["done", "canceled"] as const).map((st) => (
                    <form key={st} action={setTaskStatus}>
                      <input type="hidden" name="task" value={t.id} /><input type="hidden" name="customer" value={customerId} /><input type="hidden" name="status" value={st} />
                      <SubmitButton size="sm" variant={st === "done" ? "secondary" : "ghost"} pendingLabel="…">{st === "done" ? "Done" : "Cancel"}</SubmitButton>
                    </form>
                  ))}
                </span>
              )}
            </li>
          );
        })}
        {closed.map((t) => (
          <li key={t.id} className="px-5 py-2 text-xs text-muted sm:px-6"><span className="line-through">{t.title}</span> — {t.status === "done" ? "done" : "canceled"}{t.completed_at ? ` ${formatDate(t.completed_at.slice(0, 10))}` : ""}</li>
        ))}
      </ul>
      {canEdit && (
        <CardBody className="border-t border-line">
          <form action={addTask} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input type="hidden" name="customer" value={customerId} />
            <Field label="Follow-up" htmlFor="task-title" className="sm:col-span-2"><Input id="task-title" name="title" required maxLength={200} placeholder="e.g. Send updated rates" /></Field>
            <Field label="Due" htmlFor="task-due"><DateInput id="task-due" name="due_on" /></Field>
            <Field label="Assigned to" htmlFor="task-to"><PeopleSelect id="task-to" name="assigned_to" names={names} empty="Unassigned" /></Field>
            <div className="sm:col-span-2"><SubmitButton size="sm" variant="secondary" pendingLabel="Adding…">Add follow-up</SubmitButton></div>
          </form>
        </CardBody>
      )}
    </Card>
  );
}

export function ActivityCard({ customerId, activities, contacts, names, canEdit, timezone }: { customerId: string; activities: Activity[]; contacts: Array<{ id: string; name: string; active: boolean }>; names: Names; canEdit: boolean; timezone: string }) {
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  return (
    <Card>
      <span id="activity" className="block scroll-mt-20" />
      <CardHeader title="Activity" description="Calls, meetings, visits and notes. Logging an email records it; nothing is sent." />
      {canEdit && (
        <CardBody className="border-b border-line">
          <form action={logActivity} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input type="hidden" name="customer" value={customerId} />
            <Field label="Kind" htmlFor="act-kind"><Select id="act-kind" name="kind" defaultValue="call">{ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{ACTIVITY_LABELS[k]}</option>)}</Select></Field>
            <Field label="With" htmlFor="act-contact">
              <Select id="act-contact" name="contact_id" defaultValue=""><option value="">—</option>{contacts.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            </Field>
            <Field label="On" htmlFor="act-on" hint="Empty = now"><DateInput id="act-on" name="occurred_on" /></Field>
            <Field label="Summary" htmlFor="act-subject" className="sm:col-span-3"><Input id="act-subject" name="subject" required maxLength={200} /></Field>
            <Field label="Details" htmlFor="act-body" className="sm:col-span-3"><Textarea id="act-body" name="body" rows={2} maxLength={4000} /></Field>
            <div className="sm:col-span-3"><SubmitButton size="sm" pendingLabel="Saving…">Log activity</SubmitButton></div>
          </form>
        </CardBody>
      )}
      {activities.length === 0 ? (
        <p className="px-5 py-3 text-sm text-muted sm:px-6">No activity recorded yet.</p>
      ) : (
        <ol className="divide-y divide-line" aria-label="Activity history">
          {activities.map((a) => (
            <li key={a.id} className="px-5 py-2.5 text-sm sm:px-6">
              <p className="flex flex-wrap items-center gap-2"><Badge>{ACTIVITY_LABELS[a.kind]}</Badge><span className="font-medium">{a.subject}</span><span className="ml-auto text-xs text-muted">{formatDateTime(a.occurred_at, timezone)}</span></p>
              {a.body && <p className="mt-1 whitespace-pre-line text-muted">{a.body}</p>}
              <p className="mt-0.5 text-xs text-muted">{names[a.created_by] ?? "Former user"}{a.contact_id ? ` · with ${contactName.get(a.contact_id) ?? "a former contact"}` : ""}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

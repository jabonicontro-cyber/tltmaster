import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { addDays, formatDate } from "@/lib/dates";
import { OPEN_STAGES, STAGE_LABELS, pipelineTotals, type Opportunity } from "@/lib/crm/labels";
import { usd } from "@/lib/site/pricing";
import { requirePagePermission } from "@/server/auth";
import { loadPipeline } from "@/server/data/crm";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Sales pipeline" };

/**
 * The company's own sales pipeline (never Taviron's platform leads): open opportunities by stage with their stated
 * values, and the follow-ups due within a week. Values are the estimates people entered; nothing here is invoiced.
 */
export default async function PipelinePage() {
  await requirePagePermission("customers.view");
  const { today } = await businessToday();
  const week = addDays(today, 7);
  const [data, names] = await Promise.all([loadPipeline(today, week), getUserNames()]);
  if (!data) return (<><PageHeader title="Sales pipeline" crumbs={[{ label: "Customers", href: "/customers" }, { label: "Pipeline" }]} /><ErrorState title="The pipeline needs a database update" description="Apply migration 20261119000100 (owner step). Customers and quotes work as before." /></>);
  const totals = pipelineTotals(data.opportunities);
  const byStage = new Map<string, Opportunity[]>(OPEN_STAGES.map((s) => [s, []]));
  for (const o of data.opportunities) byStage.get(o.stage)?.push(o);
  const closedToday = data.opportunities.filter((o) => !OPEN_STAGES.includes(o.stage));
  const followUps = [
    ...data.tasks.map((t) => ({ key: `t-${t.id}`, due: t.due_on, title: t.title, who: t.assigned_to, customerId: t.customer_id, customer: t.customers?.name ?? "Customer", kind: "Follow-up" })),
    ...data.opportunities.filter((o) => OPEN_STAGES.includes(o.stage) && o.follow_up_on && o.follow_up_on <= week).map((o) => ({ key: `o-${o.id}`, due: o.follow_up_on, title: o.next_action || o.title, who: o.owner_id, customerId: o.customer_id, customer: o.customers?.name ?? "Customer", kind: "Opportunity" })),
  ].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));

  return (
    <>
      <PageHeader title="Sales pipeline" description="Open opportunities by stage and the follow-ups due this week. Values are your own estimates." crumbs={[{ label: "Customers", href: "/customers" }, { label: "Pipeline" }]} />
      <section aria-label="Pipeline summary" className="mb-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-panel border border-line/70 bg-card shadow-card px-5 py-3 text-sm shadow-xs sm:px-6">
        <span><strong className="tabular">{totals.open}</strong> open opportunities</span>
        <span><strong className="tabular">{usd(totals.valueCents)}</strong> open value{totals.unvalued ? ` (${totals.unvalued} without a value)` : ""}</span>
        <span><strong className="tabular">{usd(totals.weightedCents)}</strong> weighted by probability</span>
        <span><Link href="/customers?relationship=prospect" className="hover:underline"><strong className="tabular">{data.prospects}</strong> prospects</Link></span>
      </section>

      {totals.open === 0 && closedToday.length === 0 ? (
        <EmptyState title="No open opportunities" description="Add one from a customer or prospect page (Opportunities → New opportunity)." />
      ) : (
        <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Pipeline by stage">
          {OPEN_STAGES.map((st) => {
            const list = byStage.get(st) ?? [];
            const value = list.reduce((n, o) => n + (o.value_cents ?? 0), 0);
            return (
              <section key={st} aria-label={STAGE_LABELS[st]} className="rounded-2xl border border-line bg-surface/40 p-2">
                <h2 className="flex items-baseline justify-between px-1 pb-2 text-sm font-semibold text-ink">{STAGE_LABELS[st]} <span className="text-xs font-normal text-muted">{list.length} · {usd(value)}</span></h2>
                <ul className="space-y-2">
                  {list.map((o) => (
                    <li key={o.id} className="rounded-control border border-line bg-card p-2.5 text-sm shadow-xs">
                      <Link href={`/customers/${o.customer_id}#opportunities`} className="font-semibold hover:underline">{o.title}</Link>
                      <p className="text-xs text-muted">{o.customers?.name}</p>
                      <p className="mt-1 flex flex-wrap gap-x-2 text-xs"><span className="tabular">{o.value_cents !== null ? usd(o.value_cents) : "No value"}</span>{o.probability !== null && <span className="text-muted">{o.probability}%</span>}
                        {o.follow_up_on && <span className={o.follow_up_on < today ? "font-semibold text-critical" : "text-muted"}>follow up {formatDate(o.follow_up_on)}</span>}</p>
                    </li>
                  ))}
                  {list.length === 0 && <li className="px-1 text-xs text-muted">None</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader title="Due this week" description="Open follow-ups and opportunity follow-up dates up to one week ahead, overdue first." />
        {followUps.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted sm:px-6">Nothing due this week.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Due this week">
            {followUps.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                <Badge tone={f.kind === "Follow-up" ? "blue" : "gray"}>{f.kind}</Badge>
                <span className="min-w-0 flex-[1_1_14rem]"><span className="font-medium">{f.title}</span> · <Link href={`/customers/${f.customerId}`} className="hover:underline">{f.customer}</Link></span>
                <span className="text-xs text-muted">{f.who ? names[f.who] ?? "Former user" : "Unassigned"}</span>
                <span className={`text-xs ${f.due && f.due < today ? "font-semibold text-critical" : "text-muted"}`}>{f.due ? `${f.due < today ? "Overdue · " : ""}${formatDate(f.due)}` : "No date"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

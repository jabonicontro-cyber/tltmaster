import { redirect } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { addDays } from "@/lib/dates";
import { addTrucks, baselineFrom, rateChange } from "@/lib/insights/what-if";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "What if" };

const DAYS = 90;
const signed = (c: number) => `${c >= 0 ? "+" : "−"}${formatCents(Math.abs(c))}`;

/**
 * "What if" planner (B123): add trucks or change a customer's rates and see the effect per month, from the company's
 * own last 90 days. Estimates from averages, labelled; nothing is changed.
 */
export default async function WhatIfPage({ searchParams }: { searchParams: Promise<{ trucks?: string; customer?: string; pct?: string }> }) {
  const access = await requireAccess();
  if (!can(access, "billing.view")) redirect("/reports");
  const sp = await searchParams;
  const trucks = Math.max(0, Math.min(10, Math.round(Number(sp.trucks ?? 1)) || 0));
  const pct = Math.max(-30, Math.min(30, Number(sp.pct ?? 5) || 0));
  const { today } = await businessToday();
  const from = addDays(today, -DAYS);
  const to = addDays(today, -1);
  const supabase = await createClient();
  const [ops, profit] = await Promise.all([
    supabase.rpc("report_operations", { p_from: from, p_to: to }).then((r) => (r.error ? null : (r.data as { fleet?: Array<{ loads: number; days_with_loads: number }> }))),
    supabase.rpc("report_profit", { p_from: from, p_to: to }).then((r) => (r.error ? null : (r.data as { loads_costed: number; revenue_cents: number; cost_cents: number; has_rates: boolean; by_customer: Array<{ name: string; revenue_cents: number; loads: number }> }))),
  ]);
  const base = baselineFrom(ops?.fleet ?? [], profit, DAYS);
  const t = addTrucks(base, trucks);
  const customers = (profit?.by_customer ?? []).filter((c) => c.revenue_cents > 0).sort((a, b) => b.revenue_cents - a.revenue_cents);
  const chosen = customers.find((c) => c.name === sp.customer) ?? customers[0] ?? null;
  const rate = chosen ? rateChange(chosen.revenue_cents, DAYS, pct) : null;

  return (
    <>
      <PageHeader
        title="What if"
        description="Try a change before you make it. Results are estimates from your own last 90 days — averages per truck and per load — and nothing is changed."
        actions={<ButtonLink href="/reports" variant="secondary">Reports</ButtonLink>}
      />
      <form method="get" className="space-y-5" aria-label="What if">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Add trucks" description="Trucks that work like your current fleet, if there is work for them." />
            <CardBody className="space-y-4">
              <Field label="Trucks to add" htmlFor="wi-trucks"><Input id="wi-trucks" name="trucks" type="number" min={0} max={10} defaultValue={trucks} className="max-w-28" /></Field>
              {t ? (
                <dl className="grid grid-cols-3 gap-3 text-sm" aria-label="Add trucks result">
                  <div><dt className="text-muted">Extra loads / month</dt><dd className="text-2xl font-semibold tabular">+{t.extraLoadsPerMonth}</dd></div>
                  <div><dt className="text-muted">Revenue / month</dt><dd className="text-2xl font-semibold tabular">{t.extraRevenueCents === null ? "—" : signed(t.extraRevenueCents)}</dd></div>
                  <div><dt className="text-muted">Profit / month</dt><dd className="text-2xl font-semibold tabular">{t.extraProfitCents === null ? "—" : signed(t.extraProfitCents)}</dd></div>
                </dl>
              ) : <p className="text-sm text-muted">Not enough delivered loads in the last 90 days to estimate.</p>}
              <p className="text-xs text-muted">
                Based on {base.loadsPerTruckDay ? `${base.loadsPerTruckDay.toFixed(1)} loads per truck-day` : "no truck-days"} and {base.workingDays} working days in 90.
                {base.profitPerLoadCents === null ? " Profit needs cost rates (Settings → Cost rates)." : ` ${formatCents(base.profitPerLoadCents)} average profit per load.`} It assumes customers would give you the extra work.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Change a customer's rates" description="The same work at a different price." />
            <CardBody className="space-y-4">
              {chosen ? (
                <>
                  <div className="grid grid-cols-[1fr_auto] gap-3">
                    <Field label="Customer" htmlFor="wi-cust">
                      <Select id="wi-cust" name="customer" defaultValue={chosen.name}>{customers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</Select>
                    </Field>
                    <Field label="Change (%)" htmlFor="wi-pct"><Input id="wi-pct" name="pct" type="number" min={-30} max={30} step={0.5} defaultValue={pct} className="max-w-24" /></Field>
                  </div>
                  <dl className="text-sm" aria-label="Rate change result">
                    <dt className="text-muted">Per month, if they order the same</dt>
                    <dd className="text-2xl font-semibold tabular">{rate === null ? "—" : signed(rate)}</dd>
                  </dl>
                  <p className="text-xs text-muted">From {formatCents(chosen.revenue_cents)} of delivered work for {chosen.name} on {chosen.loads} loads in the last 90 days. A price change can also change how much they order.</p>
                </>
              ) : <Notice title="No priced deliveries yet">Customer revenue appears once delivered loads have accepted, priced tickets.</Notice>}
            </CardBody>
          </Card>
        </div>
        <button className="h-10 rounded-full bg-strong px-5 text-sm font-semibold text-white"><span className="pill-text">Recalculate</span></button>
      </form>
    </>
  );
}

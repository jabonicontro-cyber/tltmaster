import Link from "next/link";
import { CircleDollarSign, FileWarning, ShieldCheck } from "lucide-react";
import { CheckLeakButton, ReopenLeakButton } from "@/components/billing/leak-actions";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState, Notice } from "@/components/ui/states";
import { LEAK_KINDS, byKind, heldTotal, leakHref, missedTotal, type Leak } from "@/lib/billing/leaks";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listLeaks } from "@/server/data/leaks";

export const metadata = { title: "Revenue check" };

const DAY_CHOICES = [3, 7, 14, 30];

/**
 * Revenue leakage finder (B110, migration 20261120005100): money the records say is owed but not billed, each with the
 * place to fix it. Findings only: nothing is billed, changed or sent from here.
 */
export default async function RevenueCheckPage({ searchParams }: { searchParams: Promise<{ days?: string; show?: string }> }) {
  const access = await requirePagePermission("billing.view");
  const sp = await searchParams;
  const days = DAY_CHOICES.includes(Number(sp.days)) ? Number(sp.days) : 7;
  const showChecked = sp.show === "checked";
  const header = (
    <PageHeader
      title="Revenue check"
      description="Delivered work that was never billed, billed for the wrong quantity or rate, or whose invoice was voided. Amounts come from your tickets, rates and invoices; nothing is billed or changed from here."
      actions={<ButtonLink href="/billing" variant="secondary">Billing</ButtonLink>}
    />
  );
  const all = await listLeaks(days, true);
  if (!all) return <>{header}<Notice title="Not available yet">The revenue check needs a database update that has not been installed yet.</Notice></>;
  const open = all.filter((l) => !l.checkedReason);
  const checked = all.filter((l) => l.checkedReason);
  const shown = showChecked ? checked : open;
  const missed = missedTotal(open);
  const held = heldTotal(open);
  const kinds = byKind(open);
  const canManage = can(access, "billing.manage");
  const q = (o: { days?: number; show?: string }) => `/billing/leaks?days=${o.days ?? days}${o.show ? `&show=${o.show}` : ""}`;

  return (
    <>
      {header}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile icon={<CircleDollarSign />} tone={missed > 0 ? "amber" : "green"} label="Possible missed revenue" value={formatCents(missed)} muted={missed === 0}>
          {held > 0 ? `Estimated. Plus ${formatCents(held)} of billing held up (waiting for review), not missed.` : "Estimated from tickets and the orders' rates"}
        </StatTile>
        <StatTile icon={<FileWarning />} tone={open.length ? "amber" : "neutral"} label="Open findings" value={open.length} muted={open.length === 0}>
          {kinds.length ? `${kinds.length} kind${kinds.length === 1 ? "" : "s"}` : "Nothing to check"}
        </StatTile>
        <StatTile icon={<ShieldCheck />} label="Checked and fine" value={checked.length} muted={checked.length === 0}>
          Hidden until the amount changes
        </StatTile>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <nav aria-label="Views" className="flex gap-1 rounded-full bg-ink/[0.05] p-1">
          {[{ k: undefined, label: `Open (${open.length})` }, { k: "checked", label: `Checked (${checked.length})` }].map((v) => (
            <Link key={v.label} href={q({ show: v.k })} aria-current={(v.k === "checked") === showChecked ? "page" : undefined}
              className={cn("flex h-8 items-center rounded-full px-4 font-semibold", (v.k === "checked") === showChecked ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>
              <span className="pill-text">{v.label}</span>
            </Link>
          ))}
        </nav>
        <span className="text-muted">Count work as not billed after</span>
        <nav aria-label="Days" className="flex gap-1">
          {DAY_CHOICES.map((d) => (
            <Link key={d} href={q({ days: d, show: showChecked ? "checked" : undefined })} aria-current={d === days ? "page" : undefined}
              className={cn("rounded-full px-3 py-1 font-medium", d === days ? "bg-strong text-white" : "text-muted hover:bg-ink/5 hover:text-ink")}>
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      {shown.length === 0 ? (
        <Card>
          <EmptyState
            title={showChecked ? "Nothing marked as checked" : "Nothing slipping through"}
            description={showChecked ? "Findings you mark as fine appear here." : "Every delivery older than the limit is billed at its rates and quantities."}
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {byKind(shown).map((k) => (
            <Card key={k.kind}>
              <CardHeader
                title={<span className="flex flex-wrap items-center gap-2">{LEAK_KINDS[k.kind].label}<Badge tone="gray">{k.count}</Badge></span>}
                description={LEAK_KINDS[k.kind].hint}
                actions={k.cents ? <span className={cn("text-lg font-semibold tabular", k.cents < 0 ? "text-muted" : "text-ink")}>{formatCents(k.cents)}</span> : undefined}
              />
              <ul className="divide-y divide-line border-t border-line" aria-label={LEAK_KINDS[k.kind].label}>
                {shown.filter((l) => l.kind === k.kind).map((l) => <LeakRow key={l.key} leak={l} canManage={canManage} />)}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function LeakRow({ leak: l, canManage }: { leak: Leak; canManage: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 sm:px-6" aria-label={`${l.orderNumber} ${LEAK_KINDS[l.kind].label}`}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <Link href={`/orders/${l.orderId}`} className="font-semibold hover:underline">{l.orderNumber}</Link>
          <span className="text-muted">{l.customerName}</span>
          {l.since && <span className="text-xs text-muted">· {formatDate(l.since)}</span>}
        </p>
        <p className="text-sm text-muted">{l.detail}</p>
        {l.checkedReason && <p className="mt-0.5 text-xs text-muted">Checked: {l.checkedReason}</p>}
      </div>
      <span className="text-right">
        {l.amountCents !== null ? (
          <span className={cn("block font-semibold tabular", l.amountCents < 0 ? "text-muted" : "text-ink")}>{formatCents(l.amountCents)}</span>
        ) : <span className="block text-sm text-muted">Amount unknown</span>}
        {l.estimated && <span className="block text-xs text-muted">Estimated</span>}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <ButtonLink href={leakHref(l)} size="sm" variant="secondary">{LEAK_KINDS[l.kind].fix}</ButtonLink>
        {canManage && (l.checkedReason ? <ReopenLeakButton findingKey={l.key} /> : <CheckLeakButton findingKey={l.key} label={l.orderNumber} />)}
      </span>
    </li>
  );
}

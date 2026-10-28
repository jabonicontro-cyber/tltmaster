import Link from "next/link";
import { DateInput } from "@/components/ui/date-input";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FileClock, FileText } from "lucide-react";
import { QuoteStatusBadge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FilterSelect } from "@/components/ui/filter-bar";

import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { loadQuoteDashboard } from "@/server/data/dashboard";
import type { QuoteListRow } from "@/server/data/types";

type Quotes = Awaited<ReturnType<typeof loadQuoteDashboard>>;

function Stat({ label, value, sub, href, tone = "default", icon }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: "default" | "warn" | "good"; icon: ReactNode }) {
  const body = (
    <div className={cn("flex h-full items-start gap-3 rounded-2xl border bg-card p-4 shadow-xs transition-colors", href && "hover:border-strong/40", tone === "warn" ? "border-amber-300" : "border-line")}>
      <div className={cn("rounded-xl p-2", tone === "warn" ? "bg-amber-50 text-amber-800" : tone === "good" ? "bg-green-50 text-green-800" : "bg-surface text-ink")}>{icon}</div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-muted">{label}</p>
        <p className="text-2xl font-black text-ink tabular">{value}</p>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

function QuoteMiniList({ rows, empty, today }: { rows: QuoteListRow[]; empty: string; today: string }) {
  if (rows.length === 0) return <p className="px-5 py-6 text-sm text-muted sm:px-6">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.slice(0, 8).map((q) => (
        <li key={q.id} className="flex items-center justify-between gap-3 px-5 py-2.5 sm:px-6">
          <div className="min-w-0">
            <Link href={`/quotes/${q.id}`} className="font-semibold tabular hover:text-brand-fg hover:underline">{q.quote_number}</Link>
            <span className="ml-2 text-sm">{q.customer_name}</span>
            <div className="text-xs text-muted">
              {q.status === "sent" && q.last_sent_at ? `Sent ${formatDate(q.last_sent_at.slice(0, 10))} · ` : ""}
              {q.valid_until < today ? "Expired " : "Expires "}
              {formatDate(q.valid_until)}
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold tabular">{formatCents(q.total_cents)}</div>
            <QuoteStatusBadge status={q.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Quotes: figures for a period, follow-ups and expirations (from the quotes the caller can see). */
export function SalesSection({ quotes, from, to, customer, customers, followupDays, today, resetHref, compact = false, moreHref }: {
  quotes: Quotes; from: string; to: string; customer?: string; customers: Array<{ id: string; name: string }>; followupDays: number; today: string; resetHref: string;
  /** At a glance: the four figures only, with a way into the full view (period, customer, lists). */
  compact?: boolean; moreHref?: string;
}) {
  const figures = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat icon={<FileClock className="size-5" />} label="Sent, awaiting response" value={quotes.awaiting.count} sub={formatCents(quotes.awaiting.totalCents)} href="/quotes?status=sent" />
      <Stat icon={<AlertTriangle className="size-5" />} label="Need follow-up" value={quotes.followUp.length + quotes.pastExpiration.length} sub={`${quotes.followUp.length} no reply in ${followupDays}+ days · ${quotes.pastExpiration.length} past expiration`} tone={quotes.followUp.length + quotes.pastExpiration.length > 0 ? "warn" : "default"} href={compact ? moreHref : undefined} />
      <Stat icon={<CheckCircle2 className="size-5" />} label={`Accepted ${formatDate(from)} – ${formatDate(to)}`} value={quotes.accepted.count} sub={`${formatCents(quotes.accepted.totalCents)}${quotes.winRate !== null ? ` · ${quotes.winRate}% of decided` : ""}`} tone="good" href="/quotes?status=accepted" />
      <Stat icon={<FileText className="size-5" />} label="Drafts not yet sent" value={quotes.drafts.count} sub={`${formatCents(quotes.drafts.totalCents)}${quotes.staleDrafts.length ? ` · ${quotes.staleDrafts.length} untouched 7+ days` : ""}`} href="/quotes?status=draft" />
    </div>
  );
  if (compact) {
    return (
      <div className="space-y-2">
        {figures}
        {moreHref && <p className="px-1 text-sm"><Link href={moreHref} className="font-semibold text-brand-fg underline-offset-2 hover:underline">Follow-ups, accepted and expiring quotes</Link></p>}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" action="/command-center" className="flex flex-wrap items-end gap-2 rounded-panel border border-line/70 bg-card shadow-card px-4 py-3" aria-label="Sales period">
        <input type="hidden" name="view" value="sales" />
        <div>
          <label htmlFor="from" className="mb-1 block text-xs font-medium text-muted">Decisions from</label>
          <DateInput id="from" name="from" defaultValue={from} className="w-40" />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs font-medium text-muted">To</label>
          <DateInput id="to" name="to" defaultValue={to} className="w-40" />
        </div>
        <FilterSelect name="customer" label="Customer" value={customer} options={[{ value: "", label: "All customers" }, ...customers.map((c) => ({ value: c.id, label: c.name }))]} />
        <button type="submit" className={buttonClasses("dark")}>Apply</button>
        <Link href={resetHref} className={buttonClasses("ghost")}>Reset</Link>
      </form>
      {figures}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Quotes awaiting follow-up" description={`Sent with no response for ${followupDays}+ days, or past expiration.`} />
          <QuoteMiniList rows={[...quotes.pastExpiration, ...quotes.followUp]} empty="Nothing needs follow-up right now." today={today} />
        </Card>
        <Card>
          <CardHeader title="Recently accepted" description="Accepted quotes become orders automatically; open one to see its order." />
          <QuoteMiniList rows={quotes.recentAccepted} empty="No quotes accepted in this period." today={today} />
        </Card>
        <Card>
          <CardHeader title="Expiring in the next 7 days" />
          <QuoteMiniList rows={quotes.expiringSoon} empty="No sent quotes expire this week." today={today} />
        </Card>
      </div>
    </div>
  );
}

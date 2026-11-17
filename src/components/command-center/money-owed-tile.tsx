import Link from "next/link";
import { Wallet } from "lucide-react";
import { StatTile } from "@/components/ui/stat-tile";
import type { MoneyOwed } from "@/lib/billing/invoices";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";

export type MoneyOwedState = { installed: boolean; issuer: "quickbooks" | "taviron"; owed: MoneyOwed } | null;

const dollars = (c: number) => formatCents(c).replace(/\.\d\d$/, "");
export const daysLateLabel = (days: number) => `${days} day${days === 1 ? "" : "s"} late`;

/**
 * Money owed (Command Center, people who see billing): what customers still owe on issued invoices, the part past
 * due and how late the oldest is, linked to Invoices filtered to overdue. Read from the same invoices and payments as
 * Billing → Invoices; with no invoices it says how they start, never a made-up zero. Overdue is amber, not the
 * critical red: late money is not a safety alert.
 */
export function MoneyOwedTile({ money, wide = false }: { money: MoneyOwedState; wide?: boolean }) {
  const span = wide ? "col-span-2 lg:col-span-1" : undefined;
  if (!money) {
    return (
      <StatTile icon={<Wallet />} label="Money owed" value="–" muted className={span}>
        <span className="text-muted">Could not be loaded. <Link href="/billing/invoices" className="font-semibold text-brand-fg underline-offset-2 hover:underline">Open Invoices</Link></span>
      </StatTile>
    );
  }
  const o = money.owed;
  if (!money.installed) {
    return (
      <StatTile icon={<Wallet />} label="Money owed" value="–" muted className={span}>
        <span className="text-muted">Invoicing needs a database update that has not been installed yet.</span>
      </StatTile>
    );
  }
  if (o.issuedCount === 0) {
    return (
      <StatTile icon={<Wallet />} label="Money owed" value="–" muted className={span}>
        <span className="text-muted" data-testid="money-owed-empty">
          {money.issuer === "quickbooks"
            ? <>Your invoices are issued in QuickBooks, so Taviron does not see what is owed. <Link href="/settings?tab=invoicing" className="font-semibold text-brand-fg underline-offset-2 hover:underline">Settings → Invoicing</Link></>
            : <>No invoices yet: invoices appear here once orders are billed. <Link href="/billing?view=handed_off" className="font-semibold text-brand-fg underline-offset-2 hover:underline">Open Billing</Link></>}
        </span>
      </StatTile>
    );
  }
  // The whole tile is the way in (walkthrough M5: clicking the figure did nothing): the overdue invoices when some are
  // late, otherwise the invoice list.
  const href = o.overdueCents > 0 ? "/billing/invoices?view=overdue" : "/billing/invoices";
  return (
    <Link
      href={href}
      className={cn("group block min-w-0 rounded-panel transition-shadow focus-visible:outline-2 focus-visible:outline-strong [&>div]:h-full [&>div]:transition-shadow hover:[&>div]:ring-line", span)}
    >
      <StatTile icon={<Wallet />} tone={o.overdueCents > 0 ? "amber" : "brand"} label="Money owed" value={dollars(o.openCents)} muted={o.openCents === 0}>
        <span className="sr-only">{dollars(o.openCents)} owed in all. </span>
        {o.overdueCents > 0 ? (
          <span className="flex flex-col font-semibold underline-offset-2 group-hover:underline" data-testid="money-owed-overdue">
            <span className="text-amber-700">{dollars(o.overdueCents)} overdue on {o.overdueCount} invoice{o.overdueCount === 1 ? "" : "s"}</span>
            {o.oldestOverdueDays !== null && <span className="font-normal text-muted">Oldest {daysLateLabel(o.oldestOverdueDays)}</span>}
          </span>
        ) : o.openCents > 0 ? (
          <span className="text-muted underline-offset-2 group-hover:underline">{o.openCount} open invoice{o.openCount === 1 ? "" : "s"} · nothing overdue</span>
        ) : (
          <span className="text-muted underline-offset-2 group-hover:underline">Every issued invoice is paid</span>
        )}
      </StatTile>
    </Link>
  );
}

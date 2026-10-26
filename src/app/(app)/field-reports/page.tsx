import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { REPORT_KIND_LABELS } from "@/lib/driver/rules";
import { requirePagePermission } from "@/server/auth";
import { REPORT_VIEWS, listFieldReports, type ReportView } from "@/server/data/field-reports";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Driver Reports" };

const statusTone = { open: "amber", acknowledged: "blue", resolved: "green" } as const;

export default async function FieldReportsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requirePagePermission("field_reports.view");
  const sp = await searchParams;
  const view: ReportView = sp.view && sp.view in REPORT_VIEWS ? (sp.view as ReportView) : "open";
  const [{ rows, counts }, { timezone }] = await Promise.all([listFieldReports(view), businessToday()]);
  return (
    <>
      <PageHeader title="Driver Reports" description="Delays, breakdowns and equipment or inspection problems sent from the driver portal. Reports never change equipment status or loads by themselves." />
      <nav aria-label="Report views" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
        {(Object.keys(REPORT_VIEWS) as ReportView[]).map((k) => (
          <Link key={k} href={`/field-reports?view=${k}`} aria-current={k === view ? "page" : undefined}
            className={cn("flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-150", k === view ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>
            <span className="pill-text">{REPORT_VIEWS[k]}</span>
            {k === "open" && counts.open ? <Badge tone="amber">{counts.open}</Badge> : k === "acknowledged" && counts.acknowledged ? <Badge tone="blue">{counts.acknowledged}</Badge> : null}
          </Link>
        ))}
      </nav>
      <Card>
        {rows.length === 0 ? (
          <EmptyState title={`No ${view === "all" ? "" : REPORT_VIEWS[view].toLowerCase() + " "}reports`} description="Reports sent by drivers appear here and in the Command Center." />
        ) : (
          <ul className="divide-y divide-line" aria-label="Driver reports">
            {rows.map((r) => (
              <li key={r.id} className="px-5 py-3 sm:px-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/field-reports/${r.id}`} className="font-semibold hover:underline">{REPORT_KIND_LABELS[r.kind]}</Link>
                  <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                  <span className="text-sm text-muted">{formatDateTime(r.created_at, timezone)}</span>
                </div>
                <p className="text-sm">{r.snapshot.driver_name} · {r.snapshot.order_number} load {r.snapshot.load_number}{r.equipment ? ` · ${r.equipment} ${r.equipment === "truck" ? r.snapshot.truck_unit : r.snapshot.trailer_unit}` : ""}</p>
                <p className="line-clamp-2 text-sm text-muted">{r.description}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

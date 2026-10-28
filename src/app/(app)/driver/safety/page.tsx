import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/states";
import { IncidentReportForm } from "@/components/safety/report-form";
import { formatDateTime } from "@/lib/dates";
import { clockNow, INCIDENT_KINDS, INCIDENT_STATUSES, STATUS_TONE } from "@/lib/safety";
import { requirePagePermission } from "@/server/auth";
import { myReports, reportOptions } from "@/server/data/safety";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Report a safety incident" };

/**
 * A driver reports an accident, injury, damage, spill or near miss from the phone (B103). The report is the driver's
 * own (the database sets the driver); the driver then sees its status, never the office's investigation.
 */
export default async function DriverSafetyPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  await requirePagePermission("driver.portal");
  const sp = await searchParams;
  const [{ today, timezone }, mine, options] = await Promise.all([businessToday(), myReports(), reportOptions().catch(() => ({ trucks: [], drivers: [] }))]);
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <Link href="/driver" className="text-sm font-semibold text-brand-fg hover:underline">← My Day</Link>
        <h1 className="mt-1 text-[1.75rem] leading-tight font-semibold tracking-[-0.03em]">Report a safety incident</h1>
        <p className="text-sm text-muted">Only when you are parked and safe. If anyone is hurt, call 911 first.</p>
      </div>
      {sp.sent && <p role="status" className="rounded-xl bg-green-50 px-4 py-3 font-semibold text-green-900 ring-1 ring-green-200">Report sent. The office will follow up.</p>}
      {mine === null ? (
        <Notice title="Not available yet">Safety reports need a database update that has not been installed yet. Call the office to report it.</Notice>
      ) : (
        <>
          <Card>
            <CardBody>
              <IncidentReportForm today={today} now={clockNow(timezone)} trucks={options.trucks} drivers={[]} chooseDriver={false} done="/driver/safety?sent=1" />
            </CardBody>
          </Card>
          {mine.length > 0 && (
            <Card>
              <CardHeader title="My reports" description="The office investigates each report; you see its status here." />
              <ul className="divide-y divide-line" aria-label="My safety reports">
                {mine.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 px-5 py-3 sm:px-6">
                    <span className="font-semibold tabular">{r.number}</span>
                    <span>{INCIDENT_KINDS[r.kind]}</span>
                    <Badge tone={STATUS_TONE[r.status]}>{INCIDENT_STATUSES[r.status]}</Badge>
                    <span className="w-full text-sm text-muted">{formatDateTime(r.occurred_at, timezone)}{r.photos ? ` · ${r.photos} photo${r.photos === 1 ? "" : "s"}` : ""}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

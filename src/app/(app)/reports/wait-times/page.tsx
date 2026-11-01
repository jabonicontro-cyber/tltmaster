import Link from "next/link";
import { Clock, Hourglass, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { addDays, formatDate } from "@/lib/dates";
import { STOP_LABEL, isLong, median, minutesLabel, summarizeByPlace, waitMinutes } from "@/lib/dispatch/wait-times";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { listStopTimes, waitTimeSettings } from "@/server/data/wait-times";
import { redirect } from "next/navigation";

export const metadata = { title: "Wait times" };

const PERIODS = [7, 30, 90];

/**
 * Wait times at pickups and job sites (B111, migration 20261120005200): recorded Arrived / Left times, the slowest
 * places first. Track only (owner 2026-11-01): nothing here bills or charges detention.
 */
export default async function WaitTimesPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const access = await requireAccess();
  if (!can(access, "dispatch.view") && !can(access, "billing.view")) redirect("/no-access?missing=dispatch.view");
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days)) ? Number(sp.days) : 30;
  const { today } = await businessToday();
  const from = addDays(today, -(days - 1));
  const [settings, stops] = await Promise.all([waitTimeSettings(), listStopTimes(from, today)]);
  const header = (
    <PageHeader
      title="Wait times"
      description={`Time trucks spent at pickups and job sites, ${formatDate(from)} – ${formatDate(today)}, from the Arrived and Left times drivers tap on My Day. Nothing here is billed.`}
      actions={<ButtonLink href="/reports" variant="secondary">Reports</ButtonLink>}
    />
  );
  if (!stops || !settings.installed) return <>{header}<Notice title="Not available yet">Wait times need a database update that has not been installed yet.</Notice></>;

  const free = settings.freeMinutes;
  const finished = stops.filter((s) => waitMinutes(s) !== null);
  const waits = finished.map((s) => waitMinutes(s)!);
  const siteWaits = finished.filter((s) => s.stop === "site").map((s) => waitMinutes(s)!);
  const pickupWaits = finished.filter((s) => s.stop === "pickup").map((s) => waitMinutes(s)!);
  const long = free === null ? null : waits.filter((w) => w > free).length;
  const hoursOver = free === null ? null : waits.reduce((n, w) => n + Math.max(0, w - free), 0) / 60;
  const places = summarizeByPlace(stops, free);
  const recent = finished.filter((s) => isLong(waitMinutes(s), free)).slice(0, 15);

  return (
    <>
      {header}
      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <nav aria-label="Periods" className="flex gap-1 rounded-full bg-ink/[0.05] p-1">
          {PERIODS.map((p) => (
            <Link key={p} href={`/reports/wait-times?days=${p}`} aria-current={p === days ? "page" : undefined}
              className={cn("flex h-8 items-center rounded-full px-4 font-semibold", p === days ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>
              <span className="pill-text">Last {p} days</span>
            </Link>
          ))}
        </nav>
        <span className="text-muted">
          {free === null ? <>No free time set, so no wait is flagged. {can(access, "settings.manage") && <Link className="font-semibold text-brand-fg underline" href="/settings?tab=dispatch">Set it in Dispatch rules</Link>}</> : `Free time: ${free} minutes (Settings → Dispatch rules).`}
        </span>
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile icon={<MapPin />} label="Median wait at job sites" value={minutesLabel(median(siteWaits))} muted={!siteWaits.length}>{siteWaits.length} visits with both times</StatTile>
        <StatTile icon={<Clock />} label="Median wait at pickups" value={minutesLabel(median(pickupWaits))} muted={!pickupWaits.length}>{pickupWaits.length} visits with both times</StatTile>
        <StatTile icon={<Hourglass />} tone={long ? "amber" : "neutral"} label="Waits over free time" value={long === null ? "—" : long} muted={!long}>
          {hoursOver === null ? "Set a free time to flag long waits" : `${hoursOver.toFixed(1)} truck hours beyond free time`}
        </StatTile>
      </div>

      {finished.length === 0 ? (
        <Card><EmptyState title="No wait times yet" description="Drivers tap Arrived and Left at the pickup and the job site on My Day; the office can enter times too." /></Card>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Slowest places" description="Median wait per pickup and job site, slowest first." />
            <TableWrap>
              <Table aria-label="Wait by place">
                <thead><Tr><Th>Place</Th><Th>Stop</Th><Th className="text-right">Visits</Th><Th className="text-right">Median</Th><Th className="text-right">Longest</Th><Th className="text-right">Over free time</Th></Tr></thead>
                <tbody>
                  {places.slice(0, 25).map((p) => (
                    <Tr key={p.key}>
                      <Td><span className="font-medium">{p.label}</span>{p.customerName && <span className="block text-xs text-muted">{p.customerName}</span>}</Td>
                      <Td>{STOP_LABEL[p.stop]}</Td>
                      <Td className="text-right tabular">{p.visits}</Td>
                      <Td className={cn("text-right font-semibold tabular", isLong(p.medianMinutes, free) && "text-amber-800")}>{minutesLabel(p.medianMinutes)}</Td>
                      <Td className="text-right tabular">{minutesLabel(p.longest)}</Td>
                      <Td className="text-right tabular">{p.long === null ? "—" : p.long ? <Badge tone="amber">{p.long} · {minutesLabel(p.minutesOver)}</Badge> : "0"}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </Card>
          {recent.length > 0 && (
            <Card>
              <CardHeader title="Recent long waits" description="Each over the free time, newest first." />
              <ul className="divide-y divide-line border-t border-line" aria-label="Recent long waits">
                {recent.map((s) => (
                  <li key={`${s.loadId}-${s.stop}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                    <Link href={`/orders/${s.orderId}`} className="font-semibold hover:underline">{s.orderNumber}</Link>
                    <span className="text-muted">{STOP_LABEL[s.stop]} · {s.placeLabel ?? "place not recorded"}</span>
                    <span className="ml-auto font-semibold tabular">{minutesLabel(waitMinutes(s))}</span>
                    <span className="text-xs text-muted">{s.arrivedAt ? formatDate(s.arrivedAt.slice(0, 10)) : ""}{s.source === "office" ? " · entered by the office" : ""}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

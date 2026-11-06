import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";

// Truck-hours of a truck-day order (UX11): computed from the company's setting for billing review; nothing is added to
// the order or an invoice here. Missing data is shown as missing, never estimated.

export type TruckHours = {
  job_type: "loads" | "truck_day";
  billing: "tickets" | "hours";
  basis: "scheduled" | "arrived" | null;
  minimum_hours: number | string | null;
  shortfall: "bill_minimum" | "review";
  rate_cents: number | null;
  rate_source: "order" | "customer" | "standard" | null;
  trucks: Array<{
    load_id: string; load_number: number; date: string; truck: string; driver: string; start: string | null; released_at: string | null;
    release_source: string | null; trips: number; hours: number | string | null; billable: number | string | null; short: boolean;
    missing: "off" | "not_released" | "no_arrival" | null;
  }>;
};

const MISSING: Record<string, string> = {
  off: "Hours off",
  not_released: "Not released yet",
  no_arrival: "No recorded arrival",
};

const hoursText = (h: number) => `${h.toFixed(2)} h`;

export function TruckHoursCard({ data, timeZone }: { data: TruckHours; timeZone: string }) {
  const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso)) : "–");
  const byHours = data.billing === "hours";
  const counted = data.trucks.filter((t) => t.billable !== null);
  const total = counted.reduce((n, t) => n + Number(t.billable), 0);
  const allCounted = data.trucks.length > 0 && counted.length === data.trucks.length;
  const shortCount = data.trucks.filter((t) => t.short).length;
  const basisText = data.basis === "arrived" ? "from the recorded arrival until release" : data.basis === "scheduled" ? "from the scheduled start until release" : null;
  const rateText = data.rate_cents == null ? null
    : `${formatCents(data.rate_cents)} per hour (${data.rate_source === "order" ? "the order's hourly line" : data.rate_source === "customer" ? "the customer's price list" : "the standard price list"})`;

  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2">Trucks for the day{shortCount > 0 && data.shortfall === "review" ? <Badge tone="amber">{shortCount} below the minimum</Badge> : null}</span>}
        description={byHours ? "Billed by truck-hours. A computed figure for review; nothing is added to the order or an invoice here." : "Billed by ticket quantity. Hours are shown for reference."}
      />
      <CardBody className="space-y-3">
        {!data.basis ? (
          <p className="text-sm text-muted">
            Truck-hours are off. Choose which hours count in <Link href="/settings?tab=invoicing" className="underline">Settings → Invoicing</Link>.
          </p>
        ) : (
          <p className="text-sm text-muted">
            Hours count {basisText}
            {data.minimum_hours != null ? `, with a minimum of ${Number(data.minimum_hours)} h per truck (${data.shortfall === "bill_minimum" ? "the minimum is billed" : "shorter days are flagged for review"})` : ""}.
          </p>
        )}
        {data.trucks.length === 0 ? (
          <p className="text-sm text-muted">No trucks assigned yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm" aria-label="Truck-hours">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2 pr-3 font-medium">Truck</th>
                  <th className="py-2 pr-3 font-medium">Day</th>
                  <th className="py-2 pr-3 font-medium">From</th>
                  <th className="py-2 pr-3 font-medium">Released</th>
                  <th className="py-2 pr-3 text-right font-medium">Trips</th>
                  <th className="py-2 text-right font-medium">Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.trucks.map((t) => (
                  <tr key={t.load_id}>
                    <td className="py-2 pr-3"><span className="font-semibold">Truck {t.truck}</span>{t.driver ? <span className="block text-xs text-muted">{t.driver}</span> : null}</td>
                    <td className="py-2 pr-3 tabular">{formatDate(t.date)}</td>
                    <td className="py-2 pr-3 tabular">{time(t.start)}</td>
                    <td className="py-2 pr-3 tabular">{t.released_at ? `${time(t.released_at)}${t.release_source ? ` (${t.release_source === "site" ? "site contact" : t.release_source})` : ""}` : "–"}</td>
                    <td className="py-2 pr-3 text-right tabular">{t.trips}</td>
                    <td className="py-2 text-right tabular">
                      {t.missing ? <span className="text-muted">{MISSING[t.missing]}</span> : (
                        <>
                          {hoursText(Number(t.billable))}
                          {t.short && Number(t.billable) !== Number(t.hours) ? <span className="block text-xs text-muted">worked {hoursText(Number(t.hours))}, minimum billed</span> : null}
                          {t.short && Number(t.billable) === Number(t.hours) ? <span className="block text-xs text-amber-800">below the minimum: review</span> : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.basis && data.trucks.length > 0 && (
          <p className="text-sm">
            {allCounted ? <>Total <strong className="tabular">{hoursText(total)}</strong></> : <>Counted so far <strong className="tabular">{hoursText(total)}</strong> ({data.trucks.length - counted.length} {data.trucks.length - counted.length === 1 ? "truck" : "trucks"} without hours yet)</>}
            {byHours && (rateText
              ? <> × {rateText} = <strong className="tabular">{formatCents(Math.round(total * Number(data.rate_cents)))}</strong></>
              : <span className="text-muted"> · No hourly rate: add an hourly line to the order or an hourly hauling rate to the customer&apos;s price list.</span>)}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

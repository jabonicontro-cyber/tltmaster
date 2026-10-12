import Link from "next/link";
import { CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";
import { AvailabilityBadge } from "@/components/fleet/fleet-status";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { HOS_NOTE } from "@/lib/dispatch/smart";
import { addDays, formatDateLong, isIsoDate } from "@/lib/dates";
import { eligibilityMessage } from "@/lib/fleet/eligibility";
import { TRUCK_TYPE_LABELS } from "@/lib/fleet/labels";
import { formatTime } from "@/lib/orders/schedule";
import { requirePagePermission } from "@/server/auth";
import { getDispatchResources, type ResourceBooking } from "@/server/data/dispatch-resources";
import { businessToday } from "@/server/data/settings";
import type { TruckType } from "@/server/data/types";

export const metadata = { title: "Driver & truck availability" };

type Search = { date?: string; q?: string; show?: string };

function time(iso: string, timezone: string) {
  return formatTime(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(iso)));
}

function Bookings({ items, timezone, date }: { items: ResourceBooking[]; timezone: string; date: string }) {
  if (!items.length) return <span className="text-muted">Free all day</span>;
  return (
    <ul className="space-y-0.5">
      {items.map((b) => (
        <li key={b.load_id} className="whitespace-nowrap">
          <span className="tabular">{time(b.starts_at, timezone)}–{time(b.ends_at, timezone)}</span>{" "}
          <Link href={`/dispatch?date=${date}&load=${b.load_id}`} className="hover:underline">{b.order_number} load {b.load_number}</Link>
        </li>
      ))}
    </ul>
  );
}

export default async function DispatchResourcesPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePagePermission("dispatch.view");
  const sp = await searchParams;
  const { today } = await businessToday();
  const date = sp.date && isIsoDate(sp.date) ? sp.date : today;
  const r = await getDispatchResources(date);
  const q = (sp.q ?? "").trim().toLowerCase();
  const show = sp.show ?? "";
  const trucks = r.trucks
    .filter((t) => !q || t.unit_number.toLowerCase().includes(q) || (t.driver?.name ?? "").toLowerCase().includes(q))
    .filter((t) => show === "" || (show === "available" ? t.availability.ready && !t.shopToday : !(t.availability.ready && !t.shopToday)));
  const drivers = r.drivers
    .filter((d) => !q || d.name.toLowerCase().includes(q) || (d.primaryTruck?.unit ?? "").toLowerCase().includes(q))
    .filter((d) => show === "" || (show === "available" ? d.qualification.eligible : !d.qualification.eligible));
  const readyTrucks = r.trucks.filter((t) => t.availability.ready && !t.shopToday).length;
  const qualifiedDrivers = r.drivers.filter((d) => d.qualification.eligible).length;
  const href = (d: string) => `/dispatch/resources?date=${d}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}${show ? `&show=${show}` : ""}`;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Dispatch", href: `/dispatch?date=${date}` }, { label: "Availability" }]}
        title="Driver & truck availability"
        description={`${formatDateLong(date)}${date === today ? " — today" : ""}. Mechanical availability, bookings, shop visits and driver qualifications. Hours of service are shown separately and are not verified.`}
        actions={<div className="flex gap-2">
          <ButtonLink href={href(addDays(date, -1))} variant="secondary" icon={<ChevronLeft className="size-4" />} aria-label="Previous day">Previous</ButtonLink>
          <ButtonLink href={href(addDays(date, 1))} variant="secondary" icon={<ChevronRight className="size-4" />} aria-label="Next day">Next</ButtonLink>
        </div>}
      />

      <p role="note" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">{HOS_NOTE} Time off (PTO) is not recorded in Taviron yet.</p>
      {!r.maintenanceChecked && <p role="note" className="mb-4 text-sm text-muted">Shop visits are not shown: the maintenance database update is not installed yet. Out-of-service status is still enforced.</p>}

      <section aria-label="Summary" className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card><CardBody><p className="text-sm text-muted">Trucks mechanically ready</p><p className="text-2xl font-bold tabular">{readyTrucks} / {r.trucks.length}</p></CardBody></Card>
        <Card><CardBody><p className="text-sm text-muted">Drivers qualified on this date</p><p className="text-2xl font-bold tabular">{qualifiedDrivers} / {r.drivers.length}</p></CardBody></Card>
        <Card><CardBody><p className="text-sm text-muted">Loads without a truck</p><p className="text-2xl font-bold tabular"><Link href={`/dispatch?date=${date}`} className="hover:underline">{r.unassignedLoads}</Link></p></CardBody></Card>
      </section>

      <Card className="mb-5">
        <FilterBar action="/dispatch/resources" query={sp.q} placeholder="Search truck or driver…" clearHref={`/dispatch/resources?date=${date}`}>
          <input type="hidden" name="date" value={date} />
          <FilterSelect name="show" label="Show" value={show} options={[{ value: "", label: "Everyone" }, { value: "available", label: "Ready / qualified" }, { value: "unavailable", label: "Not available" }]} />
        </FilterBar>
        <CardHeader title="Trucks" description="Ready means in service with no safety restriction and no shop visit on this date. Bookings come from active assignments." />
        <TableWrap>
          <Table>
            <thead><tr><Th>Truck</Th><Th>Availability</Th><Th>Bookings</Th><Th className="hidden md:table-cell">Primary driver</Th></tr></thead>
            <tbody>
              {trucks.map((t) => (
                <Tr key={t.id}>
                  <Td>
                    <Link href={`/fleet/trucks/${t.id}`} className="font-semibold tabular hover:underline">{t.unit_number}</Link>
                    <div className="text-xs text-muted">{TRUCK_TYPE_LABELS[t.truck_type as TruckType] ?? t.truck_type}</div>
                  </Td>
                  <Td>
                    {t.shopToday && t.availability.ready
                      ? <Badge tone="amber"><CalendarClock className="size-3" aria-hidden />In the shop this day</Badge>
                      : <AvailabilityBadge a={t.availability} />}
                    <div className="mt-1 max-w-72 text-xs text-muted">{t.shopToday ? `${t.shopToday.number}: ${t.shopToday.title}` : t.availability.ready ? (t.availability.upcoming[0] ? `Next shop visit ${t.availability.upcoming[0].date}` : "") : t.availability.detail}</div>
                  </Td>
                  <Td className="text-sm"><Bookings items={t.bookings} timezone={r.timezone} date={date} /></Td>
                  <Td className="hidden text-sm md:table-cell">{t.driver ? <Link href={`/fleet/drivers/${t.driver.id}`} className="hover:underline">{t.driver.name}</Link> : <span className="text-muted">—</span>}</Td>
                </Tr>
              ))}
              {trucks.length === 0 && <Tr><Td className="text-muted" colSpan={4}>No trucks match.</Td></Tr>}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <Card>
        <CardHeader title="Drivers" description="Qualification = verified, unexpired CDL (class B or higher) and medical card on this date. It does not mean the driver is legally within hours of service." />
        <TableWrap>
          <Table>
            <thead><tr><Th>Driver</Th><Th>Qualification</Th><Th>Bookings</Th><Th className="hidden md:table-cell">Hours of service</Th><Th className="hidden lg:table-cell">Primary truck</Th></tr></thead>
            <tbody>
              {drivers.map((d) => (
                <Tr key={d.id}>
                  <Td><Link href={`/fleet/drivers/${d.id}`} className="font-semibold hover:underline">{d.name}</Link></Td>
                  <Td>
                    <Badge tone={d.qualification.eligible ? "green" : "red"}>{d.qualification.eligible ? "Qualified" : "Not qualified"}</Badge>
                    {(d.qualification.blockers.length > 0 || d.qualification.warnings.length > 0) && (
                      <div className="mt-1 max-w-72 text-xs text-muted">{[...d.qualification.blockers, ...d.qualification.warnings].map(eligibilityMessage).join(" ")}</div>
                    )}
                  </Td>
                  <Td className="text-sm"><Bookings items={d.bookings} timezone={r.timezone} date={date} /></Td>
                  <Td className="hidden md:table-cell"><Badge tone="gray">Not verified</Badge></Td>
                  <Td className="hidden text-sm lg:table-cell">{d.primaryTruck ? <Link href={`/fleet/trucks/${d.primaryTruck.id}`} className="tabular hover:underline">{d.primaryTruck.unit}</Link> : <span className="text-muted">—</span>}</Td>
                </Tr>
              ))}
              {drivers.length === 0 && <Tr><Td className="text-muted" colSpan={5}>No drivers match.</Td></Tr>}
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </>
  );
}

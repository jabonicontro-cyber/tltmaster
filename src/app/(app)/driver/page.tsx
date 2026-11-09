import { OfflineSupport } from "@/components/companion/offline-support";
import { InspectionForm } from "@/components/fleet/inspection-form";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ClipboardCheck, FilePlus2, MapPin, Navigation, Package, Phone, Truck, Wrench } from "lucide-react";
import { directionsUrl, telUrl, type LoadPickup } from "@/lib/driver/navigate";
import { appointmentText, STOP_KIND_LABELS, type DriverStop } from "@/lib/orders/stops";
import { vocabulary, type Vocabulary } from "@/lib/industry";
import { getSettings } from "@/server/data/settings";

const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { Badge } from "@/components/ui/badge";
import { StatTile } from "@/components/ui/stat-tile";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { greeting } from "@/lib/people/greeting";
import { shownName } from "@/server/data/profile";
import { isPlatformAdmin } from "@/server/platform";
import { addDays, formatDate, formatDateTime } from "@/lib/dates";
import { DRIVER_TICKET_STATUS, REPORT_KIND_LABELS, REPORT_STATUS_LABELS, qualificationReminders, siteAddress } from "@/lib/driver/rules";
import { trimNumber } from "@/lib/fleet/labels";
import { formatTime } from "@/lib/orders/schedule";
import { reviewReasonLabel } from "@/lib/tickets/rules";
import { requirePagePermission } from "@/server/auth";
import { can } from "@/lib/permissions";
import { loadDispatchUpdates, loadDriverHome, loadMaintenanceNotices, type DriverAssignment } from "@/server/data/driver";
import { listStopTimes, stopTimesForLoads } from "@/server/data/wait-times";
import { median, minutesLabel, waitMinutes } from "@/lib/dispatch/wait-times";
import { StopButtons, type StopState } from "@/components/driver/stop-buttons";
import { ReleaseTruckButton, releasedText } from "@/components/dispatch/truck-day";
import { DispatchUpdates } from "@/components/companion/dispatch-updates";
import { directionsNeedAttention } from "@/lib/sites";
import { Freshness } from "@/components/companion/freshness";
import { myOffers } from "@/server/data/hired-trucks";
import { createClient } from "@/server/supabase/server";
import { MyScorecard } from "@/components/drivers/scorecard";
import { SCORECARD_DAYS } from "@/lib/drivers/scorecard";
import { loadScorecard } from "@/server/data/driver-scorecard";
import { RATE_UNIT_LABELS } from "@/lib/hired-trucks";
import { formatCents } from "@/lib/money";
import { SubmitButton } from "@/components/ui/submit-button";
import { answerMyOffer } from "@/app/(app)/hired-trucks/actions";
import { getMyShifts } from "@/server/data/schedules";
import { shiftLine } from "@/lib/schedule/shifts";
import { myShiftOffers } from "@/server/data/shift-offers";
import { MyShiftOffers } from "@/components/schedule/shift-offers";
import { FuelForm, TripSheetForm } from "@/components/fleet/fuel-forms";
import { homeState } from "@/server/data/fuel";

export const metadata = { title: "My Day" };

/** The moment this page's data was read (server time). */
const readTime = () => Date.now();

const big = "min-h-12 w-full justify-center text-base sm:w-auto";

/** The order's stops in order (MK2): what to pick up and drop where, with appointments and a way to navigate to each. */
function RouteStops({ route }: { route: DriverStop[] }) {
  return (
    <ol className="space-y-2" aria-label="Stops">
      {route.map((s) => {
        const to = directionsUrl({ address: s.address || s.name });
        const when = appointmentText(s);
        return (
          <li key={s.seq} className="flex gap-3 rounded-xl bg-surface px-3 py-2.5">
            <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold tabular", s.kind === "pickup" ? "bg-strong text-white" : "bg-ink/[0.08] text-ink")} aria-hidden>{s.seq}</span>
            <div className="min-w-0 flex-1">
              <p><span className="text-sm font-semibold text-muted">{STOP_KIND_LABELS[s.kind]}</span> <strong>{s.name}</strong></p>
              {s.address ? <p className="text-sm text-muted">{s.address}</p> : null}
              {when ? <p className="text-sm font-semibold tabular">{when}</p> : null}
              {s.reference ? <p className="text-sm">Ref <strong>{s.reference}</strong></p> : null}
              {s.notes ? <p className="whitespace-pre-line text-sm text-muted">{s.notes}</p> : null}
            </div>
            {to && (
              <a href={to} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm", "min-h-11 shrink-0 self-center")}>
                <Navigation className="size-4" aria-hidden /> Go<span className="sr-only"> to stop {s.seq}, {s.name}</span>
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}

type TruckDayState = { load_id: string; released_at: string | null; release_source: string | null; started: boolean };

function AssignmentCard({ a, today, timeZone, past, photos = [], stops, usualWait, userId, pickup, route, truckDay, words = vocabulary("aggregate") }: { a: DriverAssignment; /** Truck-day job (UX11): the truck works until released; one ticket per trip. */ truckDay?: TruckDayState; /** Ticket or BOL wording (MK1). */ words?: Vocabulary; today: string; timeZone: string; past?: boolean; /** Where to load (UX7); absent when the order names none. */ pickup?: LoadPickup; /** The order's stops in order (MK2); when present they replace the pickup and job-site lines. */ route?: DriverStop[]; /** Offline taps wait on the phone for this person (B133). */ userId?: string; /** Job-site photos the office applied (B94). */ photos?: string[]; /** Arrival and departure (B111); undefined for later days. */ stops?: StopState[]; /** Their usual wait at this site in minutes (B121), from their own recorded stops. */ usualWait?: number | null }) {
  const site = siteAddress(a.site);
  const hasTicket = a.tickets.length > 0;
  const risk = a.site.directions_risk ?? "standard";
  const checkDirections = directionsNeedAttention(a.site.directions_status, risk);
  // One tap to the phone's maps app (UX7): to the pickup, then the job site; Call when the order has a site contact number.
  const hasRoute = !!route && route.length > 0;
  const toPickup = pickup && !hasRoute ? directionsUrl(pickup) : null;
  const toSite = hasRoute ? null : directionsUrl({ address: [a.site.line1, a.site.city, a.site.state, a.site.postal_code].filter(Boolean).join(", ") });
  const call = telUrl(a.order.contact_phone);
  return (
    <li className={cn("overflow-hidden rounded-panel bg-card shadow-card ring-1", past ? "ring-brand" : "ring-line/60")} aria-label={`Load ${a.load.number}, ${a.order.number}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <p className="text-2xl font-semibold tracking-[-0.03em] tabular">
          {formatTime(a.load.start_time)}<span className="text-base font-semibold text-muted"> – {formatTime(a.load.end_time)}</span>
        </p>
        <p className="text-sm font-semibold text-muted">{a.load.date === today ? "Today" : formatDate(a.load.date)} · {a.order.number} · {truckDay ? "for the day" : `load ${a.load.number}`}</p>
      </div>
      <div className="space-y-2 px-4 py-3 text-[15px]">
        <p className="font-bold">{a.order.customer_name}{a.order.project_name ? <span className="font-normal text-muted"> · {a.order.project_name}</span> : null}</p>
        {hasRoute && <RouteStops route={route!} />}
        {pickup && !hasRoute && (
          <p className="flex gap-2"><Package className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span>Load at <strong>{pickup.name}</strong>{pickup.address ? <span className="text-muted"> · {pickup.address}</span> : null}</span></p>
        )}
        {!hasRoute && (a.site.label || site) && (
          <p className="flex gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span>{a.site.label ? <strong>{a.site.label}: </strong> : null}{site}</span></p>
        )}
        <p className="flex gap-2"><Truck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span>Truck <strong>{a.truck ?? "–"}</strong>{a.trailer ? <> · trailer <strong>{a.trailer}</strong></> : null}</span></p>
        {truckDay && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2 text-sm">
            <span><strong>Truck for the day:</strong> work until you are released. Enter a {words.one} for every trip. <span className="tabular">{a.tickets.length} {a.tickets.length === 1 ? "trip" : "trips"} so far.</span></span>
            {truckDay.released_at ? (
              <Badge tone="green">{releasedText(truckDay.released_at, truckDay.release_source, timeZone)}</Badge>
            ) : truckDay.started && !past ? (
              <ReleaseTruckButton loadId={a.load.id} label="I'm released" />
            ) : null}
          </div>
        )}
        {a.load.planned_quantity !== null && <p>Planned: <strong className="tabular">{trimNumber(a.load.planned_quantity)} {(a.load.unit_code ?? "").replace(/_/g, " ")}</strong></p>}
        {a.order.customer_po && <p className="text-sm text-muted">Customer PO {a.order.customer_po}</p>}
        {(toPickup || toSite || call) && (
          <div className="flex flex-wrap gap-2" aria-label="Directions and calls">
            {toPickup && <a href={toPickup} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md", "min-h-12 text-base")}><Navigation className="size-5" aria-hidden /> Navigate to pickup</a>}
            {toSite && <a href={toSite} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md", "min-h-12 text-base")}><Navigation className="size-5" aria-hidden /> Navigate to site</a>}
            {call && <a href={call} className={buttonClasses("secondary", "md", "min-h-12 text-base")}><Phone className="size-5" aria-hidden /> Call {a.order.contact_name || "site contact"}</a>}
          </div>
        )}
        {checkDirections && (
          <p className="flex gap-2 text-sm font-semibold text-critical">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{a.site.directions_status === "due" ? "Site directions are due for a re-check." : "Safety or access directions not verified."} Confirm them with dispatch before relying on them.</span>
          </p>
        )}
        {(a.order.job_instructions || a.site.directions || a.load.notes || a.assignment_note || a.order.contact_name || photos.length > 0) && (
          <details className="rounded-xl bg-surface px-3 py-2 text-sm">
            <summary className="cursor-pointer py-1 font-semibold">Instructions and directions</summary>
            <dl className="mt-1 space-y-1.5">
              {a.order.job_instructions && <div><dt className="font-semibold">Job</dt><dd className="whitespace-pre-line">{a.order.job_instructions}</dd></div>}
              {a.site.directions && (
                <div>
                  <dt className="font-semibold">Directions</dt>
                  <dd className="whitespace-pre-line">{a.site.directions}</dd>
                  {a.site.directions_status ? (
                    <dd className="mt-0.5 text-xs text-muted">
                      {a.site.directions_status === "verified" || a.site.directions_status === "due"
                        ? `Last checked by the office ${a.site.directions_verified_at ? formatDateTime(a.site.directions_verified_at, timeZone) : ""}`.trim()
                        : "Not checked by the office yet"}
                    </dd>
                  ) : null}
                </div>
              )}
              {photos.length > 0 && (
                <div>
                  <dt className="font-semibold">Site photos</dt>
                  <dd className="mt-1 flex gap-2">
                    {photos.map((p, i) => (
                      <a key={p} href={`/site-photos/${p}`} target="_blank" rel="noopener noreferrer" className="block size-20 overflow-hidden rounded-lg border border-line">
                        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed link */}
                        <img src={`/site-photos/${p}`} alt={`Site photo ${i + 1}`} loading="lazy" className="size-full object-cover" />
                      </a>
                    ))}
                  </dd>
                </div>
              )}
              {a.load.notes && <div><dt className="font-semibold">Load notes</dt><dd className="whitespace-pre-line">{a.load.notes}</dd></div>}
              {a.assignment_note && <div><dt className="font-semibold">From dispatch</dt><dd>{a.assignment_note}</dd></div>}
              {a.order.contact_name && <div><dt className="font-semibold">Site contact</dt><dd>{a.order.contact_name}{a.order.contact_phone ? <> · <a className="underline" href={`tel:${a.order.contact_phone}`}>{a.order.contact_phone}</a></> : null}</dd></div>}
            </dl>
          </details>
        )}
        {usualWait != null && <p className="text-sm text-muted">You usually wait about <strong className="text-ink">{minutesLabel(usualWait)}</strong> at this site (your last visits).</p>}
        {stops && <StopButtons load={a.load.id} stops={hasRoute && route!.every((r) => r.id) ? route!.map((r) => {
          // Arrived / Left at each of the order's stops (MK2 slice 2); the stop's id arrives with 20261120008000.
          const key = `stop:${r.id}` as const;
          const t = stops.find((x) => x.stop === key);
          return { stop: key, label: `${r.seq}. ${r.name}`, arrivedAt: t?.arrivedAt ?? null, departedAt: t?.departedAt ?? null };
        }) : stops} timeZone={timeZone} queue={userId ? { userId, label: `${a.order.number} load ${a.load.number}` } : undefined} />}
        {hasTicket && (
          <ul className="space-y-1" aria-label="Tickets for this load">
            {a.tickets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                <ClipboardCheck className="size-4 text-green-700" aria-hidden />
                <span className="font-semibold tabular">{t.number}</span>
                <span className="tabular">{trimNumber(t.quantity)} {t.unit_code}</span>
                <TicketStatusBadge status={t.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row">
        {a.can_submit_ticket ? (
          <Link href={`/driver/assignments/${a.assignment_id}/ticket`} className={buttonClasses(hasTicket ? "secondary" : "primary", "md", big)}>
            <FilePlus2 className="size-5" aria-hidden /> {truckDay ? `Enter ${words.one} for a trip` : hasTicket ? `Add another ${words.one}` : `Enter ${words.single.toLowerCase()}`}
          </Link>
        ) : (
          <p className="text-sm text-muted">Ticket entry opens on the day of the load.</p>
        )}
        <Link href={`/driver/assignments/${a.assignment_id}/report`} className={buttonClasses("secondary", "md", big)}>
          <AlertTriangle className="size-5" aria-hidden /> Report a problem
        </Link>
      </div>
    </li>
  );
}

export default async function DriverHomePage({ searchParams }: { searchParams: Promise<{ sent?: string; saved?: string; error?: string }> }) {
  const access = await requirePagePermission("driver.portal");
  const sp = await searchParams;
  const home = await loadDriverHome();
  const [shown, platformAdmin] = await Promise.all([shownName(access), isPlatformAdmin()]);
  const hello = greeting(shown || (home.ok ? home.data.driver.name : ""));

  // An owner or office user who does not drive has no My Day: send them to their own home.
  if (!home.ok && home.notLinked && ["dispatch.view", "tickets.view", "billing.view", "fleet.view", "orders.view", "quotes.view"].some((p) => can(access, p as Parameters<typeof can>[1]))) {
    redirect("/command-center");
  }

  if (!home.ok) {
    return (
      <div className="mx-auto max-w-xl">
        <p className="text-lg font-semibold" data-testid="greeting">{hello}</p>
        <h1 className="mb-4 text-[1.75rem] leading-tight font-semibold tracking-[-0.03em]">My Day</h1>
        {home.notLinked ? (
          <Notice tone="warning" title="Your account is not linked to a driver yet">
            Ask the office to link your login to your driver record (Fleet → Drivers). Until then no loads can be shown.
          </Notice>
        ) : (
          <ErrorState title="Your day could not be loaded" description={home.error} action={<Link href="/driver" className={buttonClasses("secondary", "md", "min-h-12")}>Try again</Link>} />
        )}
      </div>
    );
  }

  const h = home.data;
  const earlier = h.assignments.filter((a) => a.load.date < h.today);
  const today = h.assignments.filter((a) => a.load.date === h.today);
  const later = h.assignments.filter((a) => a.load.date > h.today);
  const reminders = qualificationReminders(h.qualifications, h.today);
  // These three are independent: read them together. Each is empty before its update is installed.
  const sb = await createClient();
  const [fuelTrucksRes, inspRes, payRes, pickupRes, routeRes, truckDayRes] = await Promise.all([sb.rpc("fuel_my_trucks", { p_day: h.today }), sb.rpc("inspection_my_trucks"), sb.rpc("my_pay_statements"), sb.rpc("driver_load_pickups"), sb.rpc("driver_load_stops"), sb.rpc("driver_truck_days")]);
  // Truck-day jobs (UX11): the driver's own slots, keyed by load; empty before 20261120008600 is installed.
  const truckDays = Object.fromEntries(((truckDayRes.error ? [] : truckDayRes.data ?? []) as TruckDayState[]).map((t) => [t.load_id, t]));
  // Where each load is picked up (UX7), keyed by load; empty before that update is installed.
  const pickups = (pickupRes.error ? {} : (pickupRes.data ?? {})) as Record<string, LoadPickup>;
  // Stops (MK2): absent before 20261120007800 is applied, so the card keeps the pickup and job site.
  const routes = (routeRes.error ? {} : (routeRes.data ?? {})) as Record<string, DriverStop[]>;
  // Ticket or BOL wording (MK1): from the company's "What you haul"; aggregate wording when it can't be read.
  const words = vocabulary((await getSettings().catch(() => null))?.industry);
  const fuelTrucks = fuelTrucksRes.error ? [] : ((fuelTrucksRes.data ?? []) as Array<{ id: string; unit: string; sheet_done: boolean }>);
  const fuelHome = fuelTrucks.length ? await homeState() : "IA";
  // Inspections (B132): the trucks this driver may inspect today and what is still due; empty before that update.
  const inspTrucks = (inspRes.error ? [] : ((inspRes.data ?? []) as Array<{ id: string; unit: string; pre_trip: boolean; post_trip: boolean; dump?: boolean }>))
    .map((t) => ({ id: t.id, label: `Truck ${t.unit}`, dump: Boolean(t.dump), pending: [...(t.pre_trip ? [] : ["pre_trip" as const]), ...(t.post_trip ? [] : ["post_trip" as const])] }))
    .filter((t) => t.pending.length > 0);
  const preTripDue = inspTrucks.some((t) => t.pending.includes("pre_trip"));
  // Pay statements (B131): the driver's own, for approved periods only; empty before that update is installed.
  const pay = payRes.error ? [] : ((payRes.data ?? []) as Array<{ period_id: string; starts_on: string; ends_on: string; total_cents: number }>).slice(0, 4);
  const [shop, updates, offers, score, sitePhotos, shifts, shiftOffers, stopTimes, history] = await Promise.all([
    loadMaintenanceNotices(), loadDispatchUpdates(), myOffers(),
    // The driver's own last 30 days (B96); missing update or failure: the card is simply left out.
    loadScorecard(addDays(h.today, -(SCORECARD_DAYS - 1)), h.today, true).catch(() => null),
    // Job-site photos customers sent and the office applied (B94); none before the update is installed.
    (async () => { const r = await (await createClient()).rpc("driver_site_photos"); return (r.error ? {} : (r.data ?? {})) as Record<string, string[]>; })(),
    // Their own schedule today and tomorrow (SCH-1); left out without a schedule or before the update is installed.
    getMyShifts(access.userId, h.today, 2).catch(() => null),
    // Extra shifts offered to them (B102); none before the update is installed.
    myShiftOffers("drivers").catch(() => null),
    // Arrived / Left at pickup and site (B111) for today's and earlier loads; none before the update is installed.
    stopTimesForLoads([...earlier, ...today].map((a) => a.load.id)),
    // Their own finished stops over the last 60 days (B121), for "you usually wait about N min here".
    listStopTimes(addDays(h.today, -60), addDays(h.today, -1), h.timezone).catch(() => null),
  ]);
  const stopsFor = (loadId: string) => stopTimes.filter((t) => t.loadId === loadId);
  const siteLabel = (a: DriverAssignment) => a.site.label || [a.site.line1, a.site.city].filter(Boolean).join(", ");
  const usualWait = (a: DriverAssignment): number | null => {
    const waits = (history ?? []).filter((t) => t.stop === "site" && t.placeLabel === siteLabel(a)).map((t) => waitMinutes(t)).filter((m): m is number => m !== null);
    return waits.length >= 2 ? median(waits) : null;
  };
  const shiftToday = shiftLine(shifts?.find((d) => d.date === h.today));
  const shiftTomorrow = shiftLine(shifts?.find((d) => d.date === addDays(h.today, 1)));
  // When this answer was read from Taviron: the phone says so once it may be out of date (docs/COMPANION_APP.md §4).
  const renderedAt = readTime();
  const whose = access.isDemo && shown && !platformAdmin ? shown : h.driver.name;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <p className="text-lg font-semibold" data-testid="greeting">{hello}</p>
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.03em]">My Day</h1>
        {/* Whose day this is: the driver record (the platform team member previewing a demo keeps their own name only in
            the header and greeting). Named only when the greeting does not already say it. */}
        <p className="text-muted">{whose && !hello.includes(whose.split(" ")[0]) ? `${whose} · ` : ""}{formatDate(h.today)}</p>
        {(shiftToday || shiftTomorrow) && (
          <p className="mt-1 text-sm" data-testid="my-shift">
            {shiftToday && <>Your shift: <strong className="tabular">{shiftToday}</strong></>}
            {shiftToday && shiftTomorrow ? <span className="text-muted"> · </span> : null}
            {shiftTomorrow && <span className="text-muted">Tomorrow: <span className="tabular">{shiftTomorrow}</span></span>}
          </p>
        )}
        {/* On phones the Time off tab is one tap away; the link is for wider screens without the tab bar. */}
        <Link href="/time-off" className="mt-1 hidden text-sm font-semibold underline md:inline-block">Request time off</Link>
        <Link href="/driver/safety" className="mt-1 ml-0 block text-sm font-semibold text-brand-fg underline md:ml-4 md:inline-block">Report a safety incident</Link>
        <div className="mt-2"><Freshness renderedAt={renderedAt} timeZone={h.timezone} /></div>
        <p className="mt-1 text-xs text-muted">Use Taviron only when you are parked. Nothing here needs an answer while you drive.</p>
      </div>
      {/* What just happened (a ticket or report sent, an offer answered): at the top, where My Day opens after the
          redirect, so the driver sees it without scrolling. */}
      {sp.sent && (
        <p role="status" data-testid="sent-confirmation" className="rounded-xl bg-green-50 px-4 py-3 font-semibold text-green-900 ring-1 ring-green-200">{sp.sent}</p>
      )}
      {sp.saved === "offer_accepted" && <p role="status" className="rounded-xl bg-green-50 px-4 py-3 font-semibold text-green-900 ring-1 ring-green-200">Offer accepted. Dispatch confirms it before the load is yours.</p>}
      {sp.saved === "offer_declined" && <p role="status" className="rounded-xl bg-surface px-4 py-3 font-semibold text-ink ring-1 ring-line">Offer declined.</p>}
      {sp.error && <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950 ring-1 ring-amber-200">{sp.error}</p>}
      {/* The day in two figures (owner's references 2026-10-27: numbers first). */}
      <div className="grid grid-cols-2 gap-3" aria-label="My day at a glance">
        <StatTile icon={<Truck />} tone="brand" label="Loads today" value={today.length} muted={today.length === 0}>
          <span className="text-muted"><span className="sr-only">{today.length} loads today. </span>{later.length ? `${later.length} tomorrow` : "none tomorrow yet"}</span>
        </StatTile>
        <StatTile icon={<ClipboardCheck />} tone={earlier.length ? "amber" : "neutral"} label="Tickets to enter" value={earlier.length} muted={earlier.length === 0}>
          <span className="text-muted"><span className="sr-only">{earlier.length} {words.many} to enter. </span>{earlier.length ? "from earlier days" : "all caught up"}</span>
        </StatTile>
      </div>
      {/* Pre-trip first, but one tap to open (UX6): the long form no longer pushes today's loads off the screen. */}
      {inspTrucks.length > 0 && (
        // Keyed by what is due: once the pre-trip is saved the panel starts closed again for the post-trip.
        <details key={preTripDue ? "pre-trip" : "post-trip"} className={cn("rounded-2xl border bg-card", preTripDue ? "border-amber-300 ring-1 ring-amber-200" : "border-line")}>
          <summary className="flex min-h-14 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-base font-semibold text-ink">
            <span>{preTripDue ? "Pre-trip inspection: do this before you drive" : "Post-trip inspection"}</span>
            <span className="text-sm font-medium text-brand-fg">Open</span>
          </summary>
          <div className="border-t border-line px-4 pt-3 pb-4">
            <p className="mb-3 text-sm text-muted">{preTripDue ? "Check every item. A defect goes straight to the shop." : "At the end of your shift: check every item and report anything wrong."}</p>
            <InspectionForm trucks={inspTrucks} queue={{ userId: access.userId, day: h.today }} />
          </div>
        </details>
      )}
      <section aria-label="Today">
        <h2 className="mb-2 text-lg font-bold">Today</h2>
        {today.length === 0 ? (
          <Card><EmptyState title="No loads assigned to you today" description="New assignments appear here as soon as dispatch makes them. Pull down or reopen to refresh." /></Card>
        ) : (
          <ul className="space-y-3">{today.map((a) => <AssignmentCard key={a.assignment_id} a={a} today={h.today} timeZone={h.timezone} photos={sitePhotos[a.load.id]} stops={stopsFor(a.load.id)} usualWait={usualWait(a)} userId={access.userId} pickup={pickups[a.load.id]} route={routes[a.load.id]} truckDay={truckDays[a.load.id]} words={words} />)}</ul>
        )}
      </section>
      <DispatchUpdates items={updates} timeZone={h.timezone} />

      {/* Hired trucks (B83): loads offered to this hauler's driver. Answering never assigns by itself: dispatch confirms. */}
      {offers.length > 0 && (
        <section aria-label="Load offers" className="space-y-2">
          <h2 className="text-lg font-bold">Load offers</h2>
          <ul className="space-y-3">
            {offers.map((o) => (
              <li key={o.id} className="rounded-2xl border border-line bg-card p-4" aria-label={`Offer ${o.order_number} load ${o.load_number}`}>
                <p className="font-semibold text-ink">{formatDate(o.load_date)} · {formatTime(o.start_time)}–{formatTime(o.end_time)}</p>
                <p className="text-sm text-ink">{o.order_number} load {o.load_number}{o.site ? ` · ${o.site}` : ""}</p>
                <p className="text-sm text-muted">Truck {o.truck}{o.planned_quantity ? ` · ${trimNumber(o.planned_quantity)} ${o.unit_code ?? ""}` : ""} · {formatCents(o.rate_cents)} {RATE_UNIT_LABELS[o.rate_unit]}</p>
                {o.note && <p className="mt-1 text-sm text-ink">“{o.note}”</p>}
                {o.status === "offered" ? (
                  <form action={answerMyOffer} className="mt-3 flex flex-wrap gap-2">
                    <input type="hidden" name="offer_id" value={o.id} />
                    <SubmitButton name="answer" value="accept" className={big}>Accept</SubmitButton>
                    <SubmitButton name="answer" value="decline" variant="secondary" className={big}>Decline</SubmitButton>
                  </form>
                ) : (
                  <p className="mt-2"><Badge tone={o.status === "confirmed" ? "green" : "blue"}>{o.status === "confirmed" ? "Confirmed by dispatch" : "Accepted: waiting for dispatch"}</Badge></p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Shift offers (B102): extra shifts this person can take; the database checks again when they answer. */}
      {shiftOffers && shiftOffers.length > 0 && (
        <section aria-label="Open shifts" className="rounded-2xl border border-line bg-card px-4 pt-3 pb-1">
          <h2 className="text-lg font-bold">Open shifts</h2>
          <MyShiftOffers offers={shiftOffers} />
        </section>
      )}

      {reminders.length > 0 && (
        <section aria-label="Reminders" className="space-y-2">
          {reminders.map((r) => (
            <p key={r.text} className={cn("rounded-xl px-4 py-3 text-sm font-semibold ring-1", r.tone === "bad" ? "bg-red-50 text-red-900 ring-red-200" : "bg-amber-50 text-amber-950 ring-amber-200")}>{r.text}</p>
          ))}
        </section>
      )}

      {shop.length > 0 && (
        <section aria-label={shop.some((n) => n.equipment === "trailer") ? "Truck and trailer maintenance" : "Truck maintenance"} className="space-y-2">
          <h2 className="text-lg font-bold">{shop.some((n) => n.equipment === "trailer") ? "Truck and trailer maintenance" : "Truck maintenance"}</h2>
          {shop.map((n) => (
            <p key={n.number} className={cn("flex gap-3 rounded-xl px-4 py-3 text-sm ring-1", n.notice === "canceled" ? "bg-surface text-ink ring-line" : "bg-amber-50 text-amber-950 ring-amber-200")}>
              <Wrench className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <strong>{n.equipment === "trailer" ? "Trailer" : "Truck"} {n.unit_number}: {n.title}</strong>
                {" · "}
                {n.notice === "canceled"
                  ? `the shop appointment${n.scheduled_for ? ` on ${formatDate(n.scheduled_for)}` : ""} was canceled.`
                  : n.notice === "rescheduled"
                    ? `moved to ${formatDate(n.scheduled_for)}${n.previous_date ? ` (was ${formatDate(n.previous_date)})` : ""}.`
                    : `in the shop on ${formatDate(n.scheduled_for)}.`}
                {n.safety_critical && n.notice !== "canceled" ? ` The ${n.equipment === "trailer" ? "trailer" : "truck"} is out of service until it is cleared.` : ""}
              </span>
            </p>
          ))}
        </section>
      )}

      {earlier.length > 0 && (
        <section aria-label={`${capitalize(words.many)} still needed`}>
          <h2 className="mb-2 text-lg font-bold text-brand-fg">{capitalize(words.many)} still needed</h2>
          <ul className="space-y-3">{earlier.map((a) => <AssignmentCard key={a.assignment_id} a={a} today={h.today} timeZone={h.timezone} past photos={sitePhotos[a.load.id]} stops={stopsFor(a.load.id)} usualWait={usualWait(a)} userId={access.userId} pickup={pickups[a.load.id]} route={routes[a.load.id]} truckDay={truckDays[a.load.id]} words={words} />)}</ul>
        </section>
      )}

      {/* Offline driver app (B133): keeps today on the phone and sends what is waiting once there is signal. */}
      <OfflineSupport userId={access.userId} timeZone={h.timezone} />



      {fuelTrucks.length > 0 && (
        <Card>
          <CardHeader
            title="Trip sheet and fuel"
            description={fuelTrucks.every((t) => t.sheet_done) ? "Today's trip sheet is in. Add fuel when you buy it." : "At the end of the day: odometer at the start and end, and any state line you crossed. Add fuel when you buy it."}
          />
          <div className="space-y-6 px-5 pb-5 sm:px-6">
            {fuelTrucks.some((t) => !t.sheet_done) && <TripSheetForm trucks={fuelTrucks.filter((t) => !t.sheet_done).map((t) => ({ id: t.id, label: `Truck ${t.unit}` }))} today={h.today} homeState={fuelHome} />}
            <details className="rounded-xl border border-line px-4 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Record fuel</summary>
              <div className="pt-3"><FuelForm compact trucks={fuelTrucks.map((t) => ({ id: t.id, label: `Truck ${t.unit}` }))} today={h.today} homeState={fuelHome} /></div>
            </details>
          </div>
        </Card>
      )}

      {later.length > 0 && (
        <section aria-label="Tomorrow">
          <h2 className="mb-2 text-lg font-bold">Tomorrow</h2>
          <ul className="space-y-3">{later.map((a) => <AssignmentCard key={a.assignment_id} a={a} today={h.today} timeZone={h.timezone} photos={sitePhotos[a.load.id]} usualWait={usualWait(a)} pickup={pickups[a.load.id]} route={routes[a.load.id]} truckDay={truckDays[a.load.id]} words={words} />)}</ul>
        </section>
      )}

      {/* Always reachable (UX6): an empty state says when statements will appear. */}
      <Card>
        <CardHeader title="My pay" description="Statements of approved pay periods: every ticket and its pay. Gross, before taxes." />
        {pay.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-sm text-muted sm:px-6">No pay statements yet. A statement appears here once the office approves a pay period that includes your tickets.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line" aria-label="My pay statements">
            {pay.map((p) => (
              <li key={p.period_id}>
                <Link href={`/driver/pay/${p.period_id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-ink/[0.03] sm:px-6">
                  <span className="text-sm">{formatDate(p.starts_on)} – {formatDate(p.ends_on)}</span>
                  <span className="font-semibold tabular">{formatCents(p.total_cents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title={`My recent ${words.many}`} description={`The office reviews every ${words.one}. Questions about a ${words.one} go to the office.`} />
        {h.tickets.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted sm:px-6">No {words.many} yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label={`My recent ${words.many}`}>
            {h.tickets.map((t) => (
              <li key={t.id} className="px-5 py-3 sm:px-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold tabular">{t.number}</span>
                  <TicketStatusBadge status={t.status} />
                  <span className="ml-auto font-semibold tabular">{trimNumber(t.quantity)} {t.unit_code}</span>
                </div>
                <p className="text-sm text-muted">{t.order_number} · load {t.load_number} · {formatDateTime(t.delivered_at, h.timezone)}</p>
                {/* The badge already says Accepted or Voided; the line explains only the in-between states. */}
                {t.status !== "accepted" && t.status !== "voided" && <p className="text-sm">{DRIVER_TICKET_STATUS[t.status]}</p>}
                {t.status === "needs_review" && t.review_reasons[0] && <p className="text-xs text-muted">{reviewReasonLabel(t.review_reasons[0])}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {score?.[0] ? <MyScorecard row={score[0]} days={SCORECARD_DAYS} /> : null}

      {h.reports.length > 0 && (
        <Card>
          <CardHeader title="My reports" />
          <ul className="divide-y divide-line" aria-label="My reports">
            {h.reports.map((r) => (
              <li key={r.id} className="px-5 py-3 sm:px-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{REPORT_KIND_LABELS[r.kind]}</span>
                  <Badge tone={r.status === "resolved" ? "green" : r.status === "acknowledged" ? "blue" : "amber"}>{REPORT_STATUS_LABELS[r.status]}</Badge>
                </div>
                <p className="text-sm text-muted">{r.order_number} · load {r.load_number}{r.equipment_unit ? ` · ${r.equipment_unit}` : ""} · {formatDateTime(r.created_at, h.timezone)}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

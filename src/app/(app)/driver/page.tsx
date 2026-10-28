import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ClipboardCheck, FilePlus2, MapPin, Truck, Wrench } from "lucide-react";
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

export const metadata = { title: "My Day" };

/** The moment this page's data was read (server time). */
const readTime = () => Date.now();

const big = "min-h-12 w-full justify-center text-base sm:w-auto";

function AssignmentCard({ a, today, timeZone, past, photos = [] }: { a: DriverAssignment; today: string; timeZone: string; past?: boolean; /** Job-site photos the office applied (B94). */ photos?: string[] }) {
  const site = siteAddress(a.site);
  const hasTicket = a.tickets.length > 0;
  const risk = a.site.directions_risk ?? "standard";
  const checkDirections = directionsNeedAttention(a.site.directions_status, risk);
  return (
    <li className={cn("overflow-hidden rounded-panel bg-card shadow-card ring-1", past ? "ring-brand" : "ring-line/60")} aria-label={`Load ${a.load.number}, ${a.order.number}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <p className="text-2xl font-semibold tracking-[-0.03em] tabular">
          {formatTime(a.load.start_time)}<span className="text-base font-semibold text-muted"> – {formatTime(a.load.end_time)}</span>
        </p>
        <p className="text-sm font-semibold text-muted">{a.load.date === today ? "Today" : formatDate(a.load.date)} · {a.order.number} · load {a.load.number}</p>
      </div>
      <div className="space-y-2 px-4 py-3 text-[15px]">
        <p className="font-bold">{a.order.customer_name}{a.order.project_name ? <span className="font-normal text-muted"> · {a.order.project_name}</span> : null}</p>
        {(a.site.label || site) && (
          <p className="flex gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span>{a.site.label ? <strong>{a.site.label}: </strong> : null}{site}</span></p>
        )}
        <p className="flex gap-2"><Truck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span>Truck <strong>{a.truck ?? "—"}</strong>{a.trailer ? <> · trailer <strong>{a.trailer}</strong></> : null}</span></p>
        {a.load.planned_quantity !== null && <p>Planned: <strong className="tabular">{trimNumber(a.load.planned_quantity)} {a.load.unit_code}</strong></p>}
        {a.order.customer_po && <p className="text-sm text-muted">Customer PO {a.order.customer_po}</p>}
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
            <FilePlus2 className="size-5" aria-hidden /> {hasTicket ? "Add another ticket" : "Enter delivery ticket"}
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
  const [shop, updates, offers, score, sitePhotos, shifts] = await Promise.all([
    loadMaintenanceNotices(), loadDispatchUpdates(), myOffers(),
    // The driver's own last 30 days (B96); missing update or failure: the card is simply left out.
    loadScorecard(addDays(h.today, -(SCORECARD_DAYS - 1)), h.today, true).catch(() => null),
    // Job-site photos customers sent and the office applied (B94); none before the update is installed.
    (async () => { const r = await (await createClient()).rpc("driver_site_photos"); return (r.error ? {} : (r.data ?? {})) as Record<string, string[]>; })(),
    // Their own schedule today and tomorrow (SCH-1); left out without a schedule or before the update is installed.
    getMyShifts(access.userId, h.today, 2).catch(() => null),
  ]);
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
        <div className="mt-2"><Freshness renderedAt={renderedAt} timeZone={h.timezone} /></div>
        <p className="mt-1 text-xs text-muted">Use Taviron only when you are parked. Nothing here needs an answer while you drive.</p>
      </div>
      {/* The day in two figures (owner's references 2026-10-27: numbers first). */}
      <div className="grid grid-cols-2 gap-3" aria-label="My day at a glance">
        <StatTile icon={<Truck />} tone="brand" label="Loads today" value={today.length} muted={today.length === 0}>
          <span className="text-muted"><span className="sr-only">{today.length} loads today. </span>{later.length ? `${later.length} tomorrow` : "none tomorrow yet"}</span>
        </StatTile>
        <StatTile icon={<ClipboardCheck />} tone={earlier.length ? "amber" : "neutral"} label="Tickets to enter" value={earlier.length} muted={earlier.length === 0}>
          <span className="text-muted"><span className="sr-only">{earlier.length} tickets to enter. </span>{earlier.length ? "from earlier days" : "all caught up"}</span>
        </StatTile>
      </div>
      <DispatchUpdates items={updates} timeZone={h.timezone} />
      {sp.sent && (
        <p role="status" className="rounded-xl bg-green-50 px-4 py-3 font-semibold text-green-900 ring-1 ring-green-200">{sp.sent}</p>
      )}

      {sp.saved === "offer_accepted" && <p role="status" className="rounded-xl bg-green-50 px-4 py-3 font-semibold text-green-900 ring-1 ring-green-200">Offer accepted. Dispatch confirms it before the load is yours.</p>}
      {sp.saved === "offer_declined" && <p role="status" className="rounded-xl bg-surface px-4 py-3 font-semibold text-ink ring-1 ring-line">Offer declined.</p>}
      {sp.error && <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950 ring-1 ring-amber-200">{sp.error}</p>}

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
                  <p className="mt-2"><Badge tone={o.status === "confirmed" ? "green" : "blue"}>{o.status === "confirmed" ? "Confirmed by dispatch" : "Accepted — waiting for dispatch"}</Badge></p>
                )}
              </li>
            ))}
          </ul>
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
                {" — "}
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
        <section aria-label="Tickets still needed">
          <h2 className="mb-2 text-lg font-bold text-brand-fg">Tickets still needed</h2>
          <ul className="space-y-3">{earlier.map((a) => <AssignmentCard key={a.assignment_id} a={a} today={h.today} timeZone={h.timezone} past photos={sitePhotos[a.load.id]} />)}</ul>
        </section>
      )}

      <section aria-label="Today">
        <h2 className="mb-2 text-lg font-bold">Today</h2>
        {today.length === 0 ? (
          <Card><EmptyState title="No loads assigned to you today" description="New assignments appear here as soon as dispatch makes them. Pull down or reopen to refresh." /></Card>
        ) : (
          <ul className="space-y-3">{today.map((a) => <AssignmentCard key={a.assignment_id} a={a} today={h.today} timeZone={h.timezone} photos={sitePhotos[a.load.id]} />)}</ul>
        )}
      </section>

      {later.length > 0 && (
        <section aria-label="Tomorrow">
          <h2 className="mb-2 text-lg font-bold">Tomorrow</h2>
          <ul className="space-y-3">{later.map((a) => <AssignmentCard key={a.assignment_id} a={a} today={h.today} timeZone={h.timezone} photos={sitePhotos[a.load.id]} />)}</ul>
        </section>
      )}

      <Card>
        <CardHeader title="My recent tickets" description="The office reviews every ticket. Questions about a ticket go to the office." />
        {h.tickets.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted sm:px-6">No tickets yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="My recent tickets">
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

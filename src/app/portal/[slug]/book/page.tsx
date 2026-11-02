import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BookingRequestForm, CancelBookingButton } from "@/components/portal/booking-request-form";
import { formatDate } from "@/lib/dates";
import { BOOKING_STATUS, TIME_WINDOW, type BookingStatus, type TimeWindow } from "@/lib/portal-booking";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Book loads" };

type State = {
  enabled: boolean;
  days?: Array<{ day: string; open: boolean }>;
  requests?: Array<{ id: string; day: string; loads: number; material: string; time_window: TimeWindow; notes: string; status: BookingStatus; decision_note: string; site: string | null; order_id: string | null; order_number: string | null }>;
};

/**
 * Customer self-booking (B115): request loads on the days the company opened. Days show only as open or full; every
 * request waits for the company's dispatch, and the order appears once they create it.
 */
export default async function PortalBook({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/book`);
  if (!c.features.booking) notFound();
  const [state, sites] = await Promise.all([
    portalCall<State>("portal_booking_state", { p_slug: slug }),
    c.features.orders ? portalCall<Array<{ id: string; label: string }>>("portal_sites", { p_slug: slug }) : Promise.resolve([]),
  ]);
  if (!state.enabled) notFound();
  const days = state.days ?? [];
  const requests = state.requests ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Book loads</h1>
        <p className="text-sm text-muted">Ask {c.name} for loads on an open day. Nothing is scheduled until they approve it; you will see the answer here.</p>
      </div>
      <Card>
        <CardHeader title="New request" description={days.some((d) => d.open) ? "Full days cannot be chosen." : "No open days right now. Check back soon or contact us."} />
        <CardBody><BookingRequestForm slug={slug} days={days} sites={sites} /></CardBody>
      </Card>
      <Card>
        <CardHeader title="Your requests" />
        {requests.length === 0 ? (
          <CardBody><p className="text-sm text-muted">No requests yet.</p></CardBody>
        ) : (
          <ul className="divide-y divide-line border-t border-line" aria-label="Your booking requests">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3.5 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">{formatDate(r.day)} · {r.loads} load{r.loads === 1 ? "" : "s"} · {TIME_WINDOW[r.time_window]}</p>
                  <p className="text-sm text-muted">{r.material}{r.site ? ` · ${r.site}` : ""}{r.decision_note ? ` · ${c.name}: ${r.decision_note}` : ""}</p>
                </div>
                <Badge tone={BOOKING_STATUS[r.status].tone}>{BOOKING_STATUS[r.status].label}</Badge>
                {r.order_id && c.features.orders && <Link href={`/portal/${slug}/orders/${r.order_id}`} className="text-sm font-semibold text-brand-fg hover:underline">Order {r.order_number}</Link>}
                {r.status === "pending" && <CancelBookingButton slug={slug} request={r.id} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { TicketMistakeForm } from "@/components/driver/ticket-mistake-form";
import { buttonClasses } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { formatDateTime } from "@/lib/dates";
import { uuid } from "@/lib/schemas/common";
import { requirePagePermission } from "@/server/auth";
import { loadDriverHome } from "@/server/data/driver";

export const metadata = { title: "Mistake on my ticket" };

const trim = (q: number | string) => String(Number(q));

/**
 * "Mistake on my ticket" (owner decision 2026-11-17, TM1): one of the driver's own sent tickets (their recent tickets or
 * today's loads, read through driver_portal_home: their own only). The office corrects the ticket.
 */
export default async function TicketMistakePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("driver.portal");
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const home = await loadDriverHome();
  if (!home.ok) {
    return (
      <div className="mx-auto max-w-xl">
        <ErrorState title="Your tickets could not be loaded" description="Check your signal and try again, or call the office." action={<Link href="/driver" className={buttonClasses("secondary", "md", "min-h-12")}>Back to My Day</Link>} />
      </div>
    );
  }
  const h = home.data;
  const recent = h.tickets.find((t) => t.id === id);
  const onLoad = h.assignments.flatMap((a) => a.tickets.map((t) => ({ ...t, order_number: a.order.number, load_number: String(a.load.number) }))).find((t) => t.id === id);
  const t = recent ?? onLoad;
  if (!t || t.status === "voided" || t.status === "superseded") notFound();
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-black">Mistake on ticket {t.number}</h1>
      <p className="mb-4 text-muted">
        {t.order_number} · load {t.load_number}{t.paper_number ? ` · paper ticket ${t.paper_number}` : ""} · {trim(t.quantity)} {t.unit_code}
        {recent ? ` · ${formatDateTime(recent.delivered_at, h.timezone)}` : ""}
      </p>
      {recent?.mistake_reported ? (
        <p className="rounded-xl bg-surface px-4 py-3 text-base font-semibold" role="status">You already reported a mistake on this ticket. The office is checking it; call them if anything else is wrong.</p>
      ) : (
        <TicketMistakeForm ticketId={t.id} ticketNumber={t.number} queue={{ userId: access.userId, timeZone: h.timezone }} />
      )}
    </div>
  );
}

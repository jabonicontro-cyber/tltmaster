import { brandingStyle } from "@/lib/branding";
import { formatDay, formatQuantity, formatTime, isPortalToken, scheduleText, type PortalOrderSummary } from "@/lib/portal";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: { absolute: "Delivery Status" }, robots: { index: false, follow: false } };

type Tracked = Omit<PortalOrderSummary, "po" | "project" | "updated_at"> & {
  company: { name: string; logo: string; color: string; contact_phone: string; contact_email: string };
  expires_at: string;
  loads: Array<{ date: string; start: string | null; end: string | null; canceled: boolean }>;
};

/**
 * A shared tracking link (no sign-in): only an order's status, planned schedule and confirmed quantities. The token
 * is unguessable, expires, and the company can revoke it; nothing else about the customer is shown.
 */
export default async function TrackOrder({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = isPortalToken(token) ? await supabase.rpc("portal_track", { p_token: token }) : { data: null };
  const t = data as Tracked | null;
  const loads = t?.loads.filter((l) => !l.canceled) ?? [];
  return (
    <main id="main" className="app-root min-h-dvh bg-surface px-4 py-10 text-ink" style={t ? brandingStyle({ logo: "", color: t.company.color, sidebarColor: "" }) : {}}>
      <div className="mx-auto w-full max-w-lg rounded-panel border border-line/70 bg-card shadow-card p-6">
        {!t ? (
          <>
            <h1 className="text-xl font-bold">This tracking link is not available</h1>
            <p className="mt-2 text-sm text-muted">It may have expired or been turned off. Contact the company for an update.</p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-muted">{t.company.name}</p>
            <h1 className="mt-1 text-xl font-bold">Order {t.number}</h1>
            <p className="mt-3 inline-block rounded bg-brand-light px-2 py-1 text-sm font-semibold text-brand-fg">{t.status_label}</p>
            <dl className="mt-4 space-y-2 text-sm">
              <div><dt className="text-muted">Schedule</dt><dd className="font-semibold">{scheduleText(t) ?? "Not scheduled yet"}</dd></div>
              {t.site ? <div><dt className="text-muted">Site</dt><dd className="font-semibold">{t.site}</dd></div> : null}
              <div><dt className="text-muted">Delivered</dt><dd className="font-semibold">{t.tickets_confirmed ? `${t.tickets_confirmed} confirmed (${formatQuantity(t.quantity_confirmed)})` : t.tickets_reported ? `${t.tickets_reported} being checked` : "Nothing yet"}</dd></div>
            </dl>
            {loads.length ? (
              <>
                <h2 className="mt-5 text-sm font-semibold text-muted">Planned deliveries</h2>
                <ul className="mt-2 space-y-1 text-sm">
                  {loads.map((l, i) => (
                    <li key={i}>{formatDay(l.date)}{l.start ? `, ${formatTime(l.start)}${l.end ? `–${formatTime(l.end)}` : ""}` : ""}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="mt-5 text-xs text-muted">Planned windows, not live arrival times. Link valid until {formatDay(t.expires_at)}.{t.company.contact_phone ? ` Questions: ${t.company.contact_phone}.` : ""}</p>
          </>
        )}
        <p className="mt-6 text-xs text-muted"><a href="https://mytaviron.com/" className="hover:underline">Powered by Taviron</a></p>
      </div>
    </main>
  );
}

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TrackingLinks } from "@/components/portal/staff-portal-forms";
import { createClient } from "@/server/supabase/server";

/** The portal's tracking switch and this order's links (null before the portal migration). */
async function loadTracking(orderId: string) {
  const supabase = await createClient();
  const [{ data: settings, error }, { data: rows }] = await Promise.all([
    supabase.from("portal_settings").select("enabled, feature_tracking").maybeSingle(),
    supabase.from("portal_tracking_links").select("id, expires_at, revoked_at, created_at").eq("order_id", orderId).order("created_at", { ascending: false }),
  ]);
  if (error) return null;
  const s = settings as { enabled: boolean; feature_tracking: boolean } | null;
  const now = Date.now();
  const links = ((rows ?? []) as Array<{ id: string; expires_at: string; revoked_at: string | null; created_at: string }>).map((r) => ({
    id: r.id, expires_at: r.expires_at, created_at: r.created_at, live: !r.revoked_at && Date.parse(r.expires_at) > now,
  }));
  return { enabled: Boolean(s?.enabled && s.feature_tracking), links };
}

/**
 * Order page → Customer Tracking (B66): shareable, expiring links that show only status, schedule and confirmed
 * quantities. Hidden until the company's portal has tracking turned on (and before the portal migration).
 */
export async function OrderTrackingCard({ orderId, canEdit }: { orderId: string; canEdit: boolean }) {
  const t = await loadTracking(orderId);
  if (!t || (!t.enabled && !t.links.length)) return null;
  return (
    <Card>
      <CardHeader title="Customer Tracking" description="A link the customer can share on site. No sign-in; shows status, planned windows and confirmed quantities only." />
      <CardBody>
        {canEdit ? <TrackingLinks order={orderId} links={t.links} enabled={t.enabled} /> : <p className="text-sm text-muted">{t.links.filter((l) => l.live).length} active link(s).</p>}
      </CardBody>
    </Card>
  );
}

import Link from "next/link";
import { Megaphone } from "lucide-react";
import { PublishAnnouncement } from "@/components/communications/announcement-forms";
import { Poller } from "@/components/communications/poller";
import { CommunicationsTabs } from "@/components/communications/tabs";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { formatDateTime } from "@/lib/dates";
import { DEPARTMENTS } from "@/lib/employees";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { loadAlertCounts, loadAnnouncements } from "@/server/data/communications";

export const metadata = { title: "Announcements" };

export default async function AnnouncementsPage() {
  const access = await requireAccess();
  const data = await loadAnnouncements();
  if (!data) return <CommunicationsUnavailable title="Announcements" />;
  const counts = await loadAlertCounts();
  const canAnnounce = can(access, "comms.announce");
  return (
    <>
      <Poller />
      <PageHeader title="Announcements" description="Company and department announcements. Published inside Taviron only." actions={canAnnounce ? <PublishAnnouncement /> : undefined} />
      <CommunicationsTabs active="announcements" counts={{ alerts: counts?.open, critical: counts?.critical }} />
      <Card>
        {data.items.length === 0 ? <EmptyState icon={<Megaphone className="size-6" />} title="No announcements yet" /> : (
          <ul className="divide-y divide-line">
            {data.items.map((a) => {
              const r = data.receipts.get(a.id);
              const needsAck = a.requires_ack && a.status === "published" && !r?.acknowledged_at && a.published_by !== access.userId;
              return (
                <li key={a.id}>
                  <Link href={`/communications/announcements/${a.id}`} className="flex flex-wrap items-center gap-2 px-4 py-3 hover:bg-surface">
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm text-ink ${!r?.read_at && a.published_by !== access.userId ? "font-bold" : ""}`}>{a.title}</span>
                      <span className="block truncate text-xs text-muted">
                        {a.department ? DEPARTMENTS[a.department as keyof typeof DEPARTMENTS] : "Everyone"} · {formatDateTime(a.published_at)}{a.edited_at ? " · edited" : ""}
                      </span>
                    </span>
                    {a.status === "withdrawn" && <Badge tone="gray">Withdrawn</Badge>}
                    {needsAck && <Badge tone="amber">Acknowledge</Badge>}
                    {a.requires_ack && r?.acknowledged_at && <Badge tone="green">Acknowledged</Badge>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

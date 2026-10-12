import { notFound } from "next/navigation";
import { AcknowledgeAnnouncement, ManageAnnouncement, MarkAnnouncementRead } from "@/components/communications/announcement-forms";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/dates";
import { DEPARTMENTS } from "@/lib/employees";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { loadAnnouncement, loadDirectory } from "@/server/data/communications";

export const metadata = { title: "Announcement" };

export default async function AnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireAccess();
  const { id } = await params;
  const [data, directory] = await Promise.all([loadAnnouncement(id), loadDirectory()]);
  if (data === undefined) return <CommunicationsUnavailable title="Announcement" />;
  if (data === null) notFound();
  const { announcement: a, receipts, revisions } = data;
  const names = new Map((directory ?? []).map((p) => [p.user_id, p.name]));
  const name = (u: string | null) => (u ? names.get(u) ?? "Former employee" : "—");
  const mine = receipts.find((r) => r.user_id === access.userId);
  const canAnnounce = can(access, "comms.announce");
  const audience = (directory ?? []).filter((p) => p.user_id !== a.published_by && (!a.department || p.department === a.department));
  const acked = receipts.filter((r) => r.acknowledged_at);
  return (
    <>
      {a.status === "published" && <MarkAnnouncementRead id={a.id} />}
      <PageHeader
        title={a.title}
        crumbs={[{ label: "Announcements", href: "/communications/announcements" }]}
        description={`${a.department ? DEPARTMENTS[a.department as keyof typeof DEPARTMENTS] : "Everyone"} · ${name(a.published_by)} · ${formatDateTime(a.published_at)}${a.edited_at ? ` · edited ${formatDateTime(a.edited_at)}` : ""}`}
        badges={<>{a.status === "withdrawn" && <Badge tone="gray">Withdrawn</Badge>}{a.requires_ack && <Badge tone="amber">Acknowledgment required</Badge>}</>}
        actions={canAnnounce && a.status === "published" ? <ManageAnnouncement id={a.id} title={a.title} body={a.body} /> : undefined}
      />
      <Card>
        <CardBody>
          <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-ink">{a.body}</p>
          {a.requires_ack && a.status === "published" && a.published_by !== access.userId && (
            <div className="mt-5 border-t border-line pt-4">
              {mine?.acknowledged_at ? <p className="text-sm text-green-800">You acknowledged this on {formatDateTime(mine.acknowledged_at)}.</p> : <AcknowledgeAnnouncement id={a.id} />}
            </div>
          )}
        </CardBody>
      </Card>
      {canAnnounce && (
        <Card className="mt-5">
          <CardHeader title="Receipts" description={a.requires_ack
            ? `${acked.length} of ${audience.length} current recipients acknowledged; ${receipts.filter((r) => r.read_at).length} opened it.`
            : `${receipts.filter((r) => r.read_at).length} of ${audience.length} current recipients opened it.`} />
          {a.requires_ack && (
            <ul className="divide-y divide-line">
              {audience.map((p) => {
                const r = receipts.find((x) => x.user_id === p.user_id);
                return (
                  <li key={p.user_id} className="flex items-center gap-2 px-4 py-2 text-sm">
                    <span className="flex-1 text-ink">{p.name}</span>
                    {r?.acknowledged_at ? <span className="text-xs text-green-800">Acknowledged {formatDateTime(r.acknowledged_at)}</span>
                      : r?.read_at ? <span className="text-xs text-muted">Opened, not acknowledged</span> : <span className="text-xs text-muted">Not opened</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
      {canAnnounce && revisions.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Earlier versions" />
          <ul className="divide-y divide-line">
            {revisions.map((r) => (
              <li key={r.id} className="px-4 py-3 text-sm">
                <p className="text-xs text-muted">Replaced {formatDateTime(r.edited_at)} by {name(r.edited_by)}</p>
                <p className="font-semibold text-ink">{r.old_title}</p>
                <p className="whitespace-pre-wrap text-muted">{r.old_body}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

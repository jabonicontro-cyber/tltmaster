import { notFound } from "next/navigation";
import { ConversationView } from "@/components/communications/conversation-view";
import { MembersPanel, type PanelMember } from "@/components/communications/members-panel";
import { Poller } from "@/components/communications/poller";
import { DrivingNotice } from "@/components/communications/status";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { WorkspacePanel } from "@/components/communications/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { CONVERSATION_KINDS, SCOPE_LABELS } from "@/lib/communications";
import { formatDate } from "@/lib/dates";
import { personPhoto } from "@/lib/people/avatars";
import { DEPARTMENTS } from "@/lib/employees";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { loadConversation, loadDirectory, loadSettings } from "@/server/data/communications";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Conversation" };

async function scopeText(w: { scope_type: "project" | "destination" | "loads"; order_ids: string[]; site_key: string | null; scope_date: string | null; load_ids: string[] }) {
  const supabase = await createClient();
  if (w.scope_type === "project") {
    const { data } = await supabase.from("orders").select("order_number").in("id", w.order_ids);
    const nums = (data ?? []).map((o) => (o as { order_number: string }).order_number).sort();
    return `${SCOPE_LABELS.project}: ${nums.join(", ") || `${w.order_ids.length} order(s)`}`;
  }
  if (w.scope_type === "destination") return `Deliveries to ${w.site_key ?? "the destination"} on ${formatDate(w.scope_date)}`;
  const { data } = await supabase.from("order_loads").select("load_number, orders(order_number)").in("id", w.load_ids);
  const labels = ((data ?? []) as unknown as Array<{ load_number: number; orders: { order_number: string } | null }>).map((l) => `${l.orders?.order_number ?? "Order"} load ${l.load_number}`).sort();
  return `${SCOPE_LABELS.loads}: ${labels.join(", ") || `${w.load_ids.length} load(s)`}`;
}

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string }> }) {
  const access = await requireAccess();
  const { id } = await params;
  const shown = Math.min(Math.max(Number.parseInt((await searchParams).show ?? "", 10) || 100, 100), 1000);
  const [data, directory, settings] = await Promise.all([loadConversation(id, shown), loadDirectory(), loadSettings()]);
  if (data === undefined || settings === null) return <CommunicationsUnavailable />;
  if (data === null) notFound();
  const { conversation: c, members, messages, workspace, receipts } = data;
  const people = new Map((directory ?? []).map((p) => [p.user_id, p]));
  const names: Record<string, string> = Object.fromEntries((directory ?? []).map((p) => [p.user_id, p.name]));
  const photos = Object.fromEntries((directory ?? []).map((p) => [p.user_id, personPhoto(p.user_id, p.photo_updated_at, p.avatar_key)]));
  const active = members.filter((m) => !m.left_at);
  const mine = active.find((m) => m.user_id === access.userId) ?? null;
  const isAdmin = can(access, "comms.admin");
  const canManage = c.kind === "channel" ? can(access, "comms.channels")
    : c.kind === "operation" ? can(access, "comms.operations")
    : c.kind === "group" ? mine?.role === "manager" : false;
  const canAdd = canManage || (c.kind === "group" && c.members_can_add && Boolean(mine));
  const panel: PanelMember[] = active.map((m) => ({ user_id: m.user_id, name: names[m.user_id] ?? "Former employee", role: m.role, source: m.source, person: people.get(m.user_id) ?? null }));
  const driving = active.filter((m) => m.user_id !== access.userId && people.get(m.user_id)?.work_status === "active_delivery").map((m) => names[m.user_id] ?? "A driver");

  const blocked = !mine ? "You are no longer a member of this conversation. You can read the history up to when you left."
    : c.status !== "active" ? `This conversation is ${c.status}.`
    : workspace?.sync_status === "failed" ? "Posting is paused until the workspace's membership is resynchronized."
    : !can(access, "comms.message") ? "Your role cannot send messages." : null;

  const subtitle = [CONVERSATION_KINDS[c.kind], c.department ? DEPARTMENTS[c.department as keyof typeof DEPARTMENTS] : null, c.description || null].filter(Boolean).join(" · ");

  return (
    <>
      <Poller />
      <PageHeader
        title={c.title || "Conversation"}
        description={subtitle}
        crumbs={[{ label: "Communications", href: c.kind === "channel" ? "/communications/channels" : "/communications" }]}
        badges={c.status !== "active" ? <Badge tone="gray">{c.status === "closed" ? "Closed" : "Archived"}</Badge> : undefined}
      />
      <DrivingNotice names={driving} className="mb-4" />
      {driving.length > 0 && (
        <p className="-mt-2 mb-4 text-xs text-muted">
          {settings.delivery_notifications === "defer"
            ? "Routine message notifications to drivers on an active delivery are held and sent as one catch-up notification when the delivery ends. Critical alerts are never held."
            : "Drivers on an active delivery still receive notifications (company setting). Critical alerts are never held."}
        </p>
      )}
      {!mine && <Notice title="You left this conversation">You can read messages up to when you left. Nothing new reaches you.</Notice>}
      <div className="mt-4 grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <ConversationView
            conversationId={c.id}
            me={access.userId}
            messages={messages}
            names={names}
            photos={photos}
            receipts={receipts}
            hasEarlier={data.hasEarlier}
            shown={shown}
            membersDeleteOwn={settings.members_delete_own}
            isAdmin={isAdmin}
            canManage={canManage && Boolean(mine)}
            canPost={blocked === null}
            postBlockedReason={blocked}
          />
        </Card>
        <div className="space-y-5">
          {workspace && (
            <Card>
              <CardHeader title="Workspace" />
              <CardBody>
                <WorkspacePanel
                  conversationId={c.id}
                  scope={await scopeText(workspace)}
                  status={c.status}
                  syncStatus={workspace.sync_status}
                  syncError={workspace.sync_error}
                  lastSyncedAt={workspace.last_synced_at}
                  workFinishedAt={workspace.work_finished_at}
                  archiveHours={settings.workspace_archive_hours}
                  canManage={canManage}
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <MembersPanel
                conversationId={c.id}
                kind={c.kind}
                active={c.status === "active"}
                me={access.userId}
                isMember={Boolean(mine)}
                members={panel}
                people={directory ?? []}
                canManage={canManage}
                canAdd={canAdd}
                myMutedUntil={mine?.muted_until ?? null}
                title={c.title}
                titleCustom={c.title_custom}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

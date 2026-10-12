import Link from "next/link";
import { BellOff, Briefcase, Hash, MessagesSquare, Users } from "lucide-react";
import { NewConversation } from "@/components/communications/new-conversation";
import { NotificationList } from "@/components/communications/notifications";
import { Poller } from "@/components/communications/poller";
import { PresencePicker } from "@/components/communications/presence-picker";
import { CommSearch } from "@/components/communications/search";
import { PresenceDot, WorkStatusBadge } from "@/components/communications/status";
import { CommunicationsTabs } from "@/components/communications/tabs";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { CONVERSATION_KINDS, isMuted, STATUS_DISCLAIMER } from "@/lib/communications";
import { formatDateTime } from "@/lib/dates";
import { personPhoto } from "@/lib/people/avatars";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { isCommunicationsInstalled, loadAlertCounts, loadCommunicationsHome, loadMyPresence, type InboxItem, type Person } from "@/server/data/communications";

export const metadata = { title: "Communications" };

const VIEWS = { all: "All", direct: "Direct", group: "Groups", operation: "Workspaces" } as const;
type View = keyof typeof VIEWS;

const KIND_ICON = { direct: MessagesSquare, group: Users, channel: Hash, operation: Briefcase } as const;

function Row({ c, people }: { c: InboxItem; people: Map<string, Person> }) {
  const Icon = KIND_ICON[c.kind];
  const title = c.title || (c.kind === "group" ? "Group (only you)" : CONVERSATION_KINDS[c.kind]);
  return (
    <li>
      <Link href={`/communications/c/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface">
        {c.kind === "direct" ? (
          <span className="relative">
            <Avatar name={title} size={36} {...(c.other_user_id ? personPhoto(c.other_user_id, people.get(c.other_user_id)?.photo_updated_at, people.get(c.other_user_id)?.avatar_key) : {})} />
            <PresenceDot presence={c.other_user_id ? people.get(c.other_user_id)?.presence ?? null : null} className="absolute -right-0.5 -bottom-0.5" />
          </span>
        ) : (
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-line"><Icon className="size-4 text-muted" aria-hidden /></span>
        )}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm text-ink", c.unread > 0 && "font-bold")}>{title}</span>
          <span className="block truncate text-xs text-muted">
            {CONVERSATION_KINDS[c.kind]}
            {c.last_activity ? ` · ${formatDateTime(c.last_activity)}` : ""}
            {!c.active_member ? " · You are no longer a member" : ""}
          </span>
        </span>
        {isMuted(c.muted_until) && <BellOff className="size-4 text-muted" aria-label="Muted" />}
        {c.status !== "active" && <Badge tone="gray">{c.status === "closed" ? "Closed" : "Archived"}</Badge>}
        {c.unread > 0 && <span className="rounded-full bg-strong px-2 text-xs leading-5 font-bold text-white">{c.unread}<span className="sr-only"> unread</span></span>}
      </Link>
    </li>
  );
}

export default async function CommunicationsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const access = await requireAccess();
  if (!(await isCommunicationsInstalled())) return <CommunicationsUnavailable />;
  if (!can(access, "comms.message")) {
    return (
      <>
        <PageHeader title="Communications" />
        <CommunicationsTabs active="messages" />
        <Notice title="Messaging is not part of your role">Ask your administrator if you need to send messages. You can still read announcements and alerts addressed to you.</Notice>
      </>
    );
  }
  const home = await loadCommunicationsHome();
  if (!home) return <CommunicationsUnavailable />;
  const [counts, presence] = await Promise.all([loadAlertCounts(), loadMyPresence()]);
  const sp = await searchParams;
  const view: View = sp.view && sp.view in VIEWS ? (sp.view as View) : "all";
  const people = new Map(home.directory.map((p) => [p.user_id, p]));
  const list = home.inbox.filter((c) => c.kind !== "channel" && (view === "all" || c.kind === view));
  const unread = home.inbox.reduce((n, c) => n + c.unread, 0);
  const coworkers = home.directory.filter((p) => p.user_id !== access.userId);

  return (
    <>
      <Poller />
      <PageHeader
        title="Communications"
        description="Messages, groups and operational workspaces for your company. Everything stays inside Taviron — nothing is sent by email or text."
        actions={<div className="flex flex-wrap items-center gap-3">
          <PresencePicker value={presence} />
          <NewConversation people={home.directory} canGroup={can(access, "comms.groups")} me={access.userId} />
          {can(access, "comms.operations") && <ButtonLink href="/communications/workspaces/new" variant="secondary" icon={<Briefcase className="size-4" />}>New workspace</ButtonLink>}
        </div>}
      />
      <CommunicationsTabs active="messages" counts={{ unread, alerts: counts?.open, critical: counts?.critical }} />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader title="Conversations" actions={
            <nav aria-label="Filter conversations" className="flex gap-1">
              {(Object.keys(VIEWS) as View[]).map((v) => (
                <Link key={v} href={v === "all" ? "/communications" : `/communications?view=${v}`} aria-current={v === view ? "page" : undefined}
                  className={cn("rounded px-2 py-1 text-xs font-semibold", v === view ? "bg-strong text-white" : "text-muted hover:bg-surface hover:text-ink")}>{VIEWS[v]}</Link>
              ))}
            </nav>
          } />
          {list.length === 0 ? (
            <EmptyState icon={<MessagesSquare className="size-6" />} title="No conversations yet" description="Start a direct message or a group. Operational workspaces appear here when you are added to one." />
          ) : (
            <ul className="divide-y divide-line">{list.map((c) => <Row key={c.id} c={c} people={people} />)}</ul>
          )}
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Notifications" description="Only inside Taviron. Critical alerts always notify." />
            <div tabIndex={0} role="region" aria-label="Notifications" className="max-h-[26rem] overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"><NotificationList items={home.notifications} /></div>
          </Card>
          <Card>
            <CardHeader title="Search" />
            <CardBody><CommSearch /></CardBody>
          </Card>
          <Card>
            <CardHeader title="People" description={STATUS_DISCLAIMER} />
            {coworkers.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No coworkers yet.</p> : (
              // Focusable so keyboard users can scroll the list (it has no links of its own).
              <ul tabIndex={0} aria-label="People" className="max-h-96 divide-y divide-line overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand">
                {coworkers.map((p) => (
                  <li key={p.user_id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="relative">
                      <Avatar name={p.name} size={28} {...personPhoto(p.user_id, p.photo_updated_at, p.avatar_key)} />
                      <PresenceDot presence={p.presence} className="absolute -right-0.5 -bottom-0.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink">{p.name}</span>
                    <WorkStatusBadge status={p.work_status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

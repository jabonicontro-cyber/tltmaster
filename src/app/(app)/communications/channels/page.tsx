import Link from "next/link";
import { BellOff, Hash } from "lucide-react";
import { NewChannel } from "@/components/communications/channel-form";
import { Poller } from "@/components/communications/poller";
import { CommunicationsTabs } from "@/components/communications/tabs";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { isMuted } from "@/lib/communications";
import { formatDateTime } from "@/lib/dates";
import { DEPARTMENTS } from "@/lib/employees";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { isCommunicationsInstalled, loadAlertCounts, loadCommunicationsHome } from "@/server/data/communications";

export const metadata = { title: "Channels" };

export default async function ChannelsPage() {
  const access = await requireAccess();
  if (!(await isCommunicationsInstalled())) return <CommunicationsUnavailable title="Channels" />;
  const home = can(access, "comms.message") ? await loadCommunicationsHome() : { inbox: [], directory: [], notifications: [] };
  if (!home) return <CommunicationsUnavailable title="Channels" />;
  const counts = await loadAlertCounts();
  const channels = home.inbox.filter((c) => c.kind === "channel");
  const unread = home.inbox.reduce((n, c) => n + c.unread, 0);
  return (
    <>
      <Poller />
      <PageHeader title="Channels" description="Department and topic channels you belong to."
        actions={can(access, "comms.channels") ? <NewChannel people={home.directory} me={access.userId} /> : undefined} />
      <CommunicationsTabs active="channels" counts={{ unread, alerts: counts?.open, critical: counts?.critical }} />
      <Card>
        {channels.length === 0 ? (
          <EmptyState icon={<Hash className="size-6" />} title="No channels yet"
            description={can(access, "comms.channels") ? "Create a channel for a department or a topic." : "You will see channels here when you are added to one."} />
        ) : (
          <ul className="divide-y divide-line">
            {channels.map((c) => (
              <li key={c.id}>
                <Link href={`/communications/c/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface">
                  <Hash className="size-4 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm text-ink", c.unread > 0 && "font-bold")}>{c.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {c.department ? DEPARTMENTS[c.department as keyof typeof DEPARTMENTS] : "All departments"}
                      {c.last_activity ? ` · ${formatDateTime(c.last_activity)}` : ""}
                    </span>
                  </span>
                  {isMuted(c.muted_until) && <BellOff className="size-4 text-muted" aria-label="Muted" />}
                  {!c.active_member && <Badge tone="gray">Left</Badge>}
                  {c.unread > 0 && <span className="rounded-full bg-strong px-2 text-xs leading-5 font-bold text-white">{c.unread}<span className="sr-only"> unread</span></span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

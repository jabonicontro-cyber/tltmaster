"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import type { Notification } from "@/server/data/communications";
import { markNotificationsRead } from "@/app/(app)/communications/actions";


/** In-app notifications only (Taviron sends no email or text for Communications). */
export function NotificationList({ items }: { items: Notification[] }) {
  const router = useRouter();
  const unread = items.filter((n) => !n.read_at);
  if (items.length === 0) return <p className="px-4 py-6 text-sm text-muted">No notifications.</p>;
  return (
    <div>
      {unread.length > 0 && (
        <div className="flex justify-end border-b border-line px-4 py-2">
          <Button size="sm" variant="ghost" onClick={async () => { await markNotificationsRead(null); router.refresh(); }}>Mark all read</Button>
        </div>
      )}
      <ul className="divide-y divide-line">
        {items.map((n) => (
          <li key={n.id} className={cn("flex items-start gap-3 px-4 py-2.5 text-sm", !n.read_at && "bg-strong/5")}>
            <Bell className={cn("mt-0.5 size-4 shrink-0", n.critical ? "text-critical" : "text-muted")} aria-hidden />
            <div className="min-w-0 flex-1">
              {n.link ? (
                <Link href={n.link} onClick={() => { void markNotificationsRead([n.id]); }} className={cn("block truncate text-ink hover:underline", !n.read_at && "font-semibold")}>{n.title}</Link>
              ) : <span className="block truncate text-ink">{n.title}</span>}
              <span className="text-xs text-muted">{formatDateTime(n.created_at)}</span>
            </div>
            {n.critical && <Badge tone="critical">Critical</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

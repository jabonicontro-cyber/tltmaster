import Link from "next/link";
import { cn } from "@/lib/cn";

export type CommTab = "messages" | "channels" | "alerts" | "announcements" | "settings";

export function CommunicationsTabs({ active, counts }: { active: CommTab; counts?: { unread?: number; channelUnread?: number; alerts?: number; critical?: number } }) {
  const tabs: Array<{ key: CommTab; label: string; href: string; badge?: number; critical?: boolean }> = [
    { key: "messages", label: "Messages", href: "/communications", badge: counts?.unread },
    { key: "channels", label: "Channels", href: "/communications/channels", badge: counts?.channelUnread },
    { key: "alerts", label: "Alerts", href: "/communications/alerts", badge: counts?.alerts, critical: Boolean(counts?.critical) },
    { key: "announcements", label: "Announcements", href: "/communications/announcements" },
    { key: "settings", label: "Settings", href: "/communications/settings" },
  ];
  return (
    <nav aria-label="Communications sections" className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-4 pt-1.5 pb-[7px] text-sm leading-5 font-semibold whitespace-nowrap transition-colors duration-150",
            t.key === active ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.badge ? (
            <span className={cn("rounded-full px-1.5 text-[11px] leading-5 font-bold text-white", t.critical ? "bg-critical" : "bg-strong")}>
              {t.badge > 99 ? "99+" : t.badge}
              <span className="sr-only">{t.key === "alerts" ? " open alerts" : " unread"}</span>
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { APP_CONTAINER } from "@/lib/layout";
import { ConsoleHeader, type ConsoleUser } from "../console-header";

/**
 * The frame of every console page (/admin and /staff): the `.console` scope (Taviron's own colours, never a
 * company's; globals.css "Platform console"), the sticky header and the page column. Layouts only.
 */
export function ConsoleShell({ level, user, children }: { level: "admin" | "support"; user: ConsoleUser; children: ReactNode }) {
  return (
    <div className="console min-h-dvh bg-surface text-ink">
      <ConsoleHeader level={level} user={user} />
      <main id="main" className={cn(APP_CONTAINER, "pt-8 pb-16 sm:pt-10")}>
        {children}
      </main>
    </div>
  );
}

import type { ReactNode } from "react";
import { Crumbs } from "@/components/nav/nav-memory";
import type { Crumb } from "@/components/ui/page-header";

/**
 * A console page's opening, in the website's voice: a small label naming where you are (the navigation group, e.g.
 * "Customers"), the title in display type, and one or two plain sentences saying what the page is for. `actions`
 * holds the page's one main action (a filled button) and at most a quiet secondary one. Detail pages pass `crumbs`
 * (the way back); list pages do not need them, the tabs under the header already show where you are.
 */
export function ConsolePageHeader({ eyebrow, title, description, actions, crumbs, badges }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  crumbs?: Crumb[];
  /** Status pills shown beside the title (e.g. a record's status). */
  badges?: ReactNode;
}) {
  return (
    <div className="mb-8 space-y-3">
      {crumbs && crumbs.length > 0 && <Crumbs crumbs={crumbs} />}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 max-w-3xl">
          {eyebrow ? <p className="mb-2 text-sm font-medium text-brand-fg">{eyebrow}</p> : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="console-title text-[1.875rem] font-bold text-ink sm:text-[2.25rem]">{title}</h1>
            {badges}
          </div>
          {description ? <div className="mt-3 max-w-2xl text-[15px] leading-relaxed text-pretty text-muted sm:text-base">{description}</div> : null}
        </div>
        {actions ? <div className="no-print flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

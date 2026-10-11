import type { ReactNode } from "react";
import { Crumbs } from "@/components/nav/nav-memory";

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({ title, description, actions, crumbs, badges }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: Crumb[]; badges?: ReactNode }) {
  return (
    <div className="mb-5 space-y-2">
      {crumbs && crumbs.length > 0 && <Crumbs crumbs={crumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
            {badges}
          </div>
          {description && <p className="mt-1 max-w-3xl text-[15px] text-pretty text-muted">{description}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

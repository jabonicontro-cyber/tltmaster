import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({ title, description, actions, crumbs, badges }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: Crumb[]; badges?: ReactNode }) {
  return (
    <div className="mb-5 space-y-2">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted">
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
              {c.href ? (
                <Link href={c.href} className="hover:text-ink hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span>{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
            {badges}
          </div>
          {description && <p className="mt-1 text-[15px] text-muted">{description}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

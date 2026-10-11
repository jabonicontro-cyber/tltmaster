"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { rememberListView, rememberedListView } from "@/lib/nav-memory";
import type { Crumb } from "@/components/ui/page-header";

/** Placed once in the app shell: records each list page's current view as people browse. */
export function ListViewRecorder() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    rememberListView(pathname, search.toString());
  }, [pathname, search]);
  return null;
}

/** A link to a list page that returns to the last view of it in this tab (filters kept), or the plain list. */
function useRemembered(href: string): string {
  const [resolved, setResolved] = useState(href);
  useEffect(() => {
    if (!href.includes("?")) setResolved(rememberedListView(href));
  }, [href]);
  return resolved;
}

function CrumbLink({ crumb }: { crumb: Crumb & { href: string } }) {
  const href = useRemembered(crumb.href);
  return <Link href={href} className="hover:text-ink hover:underline">{crumb.label}</Link>;
}

/**
 * Compact breadcrumbs on nested pages (sm and up), and a single subtle
 * "← Parent" link on phones. Parent links return to the remembered list view.
 */
export function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  const parent = [...crumbs].reverse().find((c): c is Crumb & { href: string } => Boolean(c.href));
  const parentHref = useRemembered(parent?.href ?? "");
  return (
    <>
      <nav aria-label="Breadcrumb" className="hidden flex-wrap items-center gap-1 text-sm text-muted sm:flex">
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
            {c.href ? <CrumbLink crumb={c as Crumb & { href: string }} /> : <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c.label}</span>}
          </span>
        ))}
      </nav>
      {parent && (
        <Link href={parentHref} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-ink sm:hidden">
          <ArrowLeft className="size-4" aria-hidden /> {parent.label}
        </Link>
      )}
    </>
  );
}

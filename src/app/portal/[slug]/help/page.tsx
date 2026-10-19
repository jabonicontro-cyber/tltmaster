import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/states";
import { ArticleVote } from "@/components/portal/portal-forms";
import { PORTAL_GENERAL_HELP } from "@/lib/portal-help";
import type { PortalHelpArticle } from "@/lib/portal";
import { createClient } from "@/server/supabase/server";
import { portalGate } from "@/server/portal";

export const metadata = { title: "Help" };

/**
 * Customer help: the company's own published articles first, then general guidance on using the portal. Public when
 * the company publishes its portal page; otherwise for its signed-in customers only (enforced by portal_help).
 */
export default async function PortalHelp({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string }> }) {
  const { slug } = await params;
  const { q = "" } = await searchParams;
  const gate = await portalGate(slug);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_help", { p_slug: slug });
  if (error) {
    if (gate.kind === "signed-out" && gate.company) {
      return <EmptyState title="Sign in to read help" action={<Link href={`/portal/${slug}/login?next=/portal/${slug}/help`} className="font-semibold text-brand-fg hover:underline">Sign in</Link>} />;
    }
    notFound();
  }
  const companyName = gate.kind === "customer" ? gate.context.name : gate.company?.name ?? "";
  const needle = q.trim().toLowerCase().slice(0, 100);
  const match = (a: { title: string; body: string; category: string }) => !needle || `${a.title} ${a.category} ${a.body}`.toLowerCase().includes(needle);
  const own = ((data as PortalHelpArticle[]) ?? []).filter(match);
  const general = PORTAL_GENERAL_HELP.filter(match);
  const categories = [...new Set(own.map((a) => a.category))];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink">Help</h1>
        <form role="search" className="w-full sm:w-72">
          <label htmlFor="help-q" className="sr-only">Search help</label>
          <input id="help-q" name="q" defaultValue={q} placeholder="Search help…" className="h-10 w-full rounded-md border border-line bg-card px-3 text-[15px] text-ink" />
        </form>
      </div>

      {categories.map((cat) => (
        <section key={cat} aria-labelledby={`cat-${cat}`} className="space-y-3">
          <h2 id={`cat-${cat}`} className="text-sm font-semibold text-muted">{cat}</h2>
          {own.filter((a) => a.category === cat).map((a) => (
            <details key={a.id} className="rounded-lg border border-line bg-card p-4">
              <summary className="cursor-pointer font-semibold text-ink">{a.title}</summary>
              <div className="mt-3 space-y-3">
                <p className="text-sm whitespace-pre-line text-ink">{a.body}</p>
                {gate.kind === "customer" ? <ArticleVote slug={slug} article={a.id} /> : null}
              </div>
            </details>
          ))}
        </section>
      ))}

      <section aria-labelledby="general-help" className="space-y-3">
        <h2 id="general-help" className="text-sm font-semibold text-muted">Using This Portal</h2>
        {general.map((a) => (
          <details key={a.id} className="rounded-lg border border-line bg-card p-4">
            <summary className="cursor-pointer font-semibold text-ink">{a.title}</summary>
            <p className="mt-3 text-sm whitespace-pre-line text-ink">{a.body}</p>
          </details>
        ))}
      </section>

      {own.length + general.length === 0 ? <p className="text-sm text-muted">Nothing matches “{q}”.</p> : null}

      <p className="rounded-md bg-surface p-4 text-sm text-ink">
        Still have a question?{" "}
        {gate.kind === "customer" && gate.context.features.support ? (
          <Link href={`/portal/${slug}/support/new`} className="font-semibold text-brand-fg hover:underline">Ask {companyName}</Link>
        ) : (
          <span>Contact {companyName} using the details on the portal home page.</span>
        )}
      </p>
    </div>
  );
}

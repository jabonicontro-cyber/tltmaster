import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { brandingStyle } from "@/lib/branding";
import { portalGate, portalPreview } from "@/server/portal";
import { stopPortalPreview } from "@/app/admin/testing-lab/actions";
import { PortalNav } from "@/components/portal/portal-nav";
import { signOutOfPortal } from "../actions";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const gate = await portalGate(slug);
  const name = gate.kind === "customer" ? gate.context.name : gate.company?.name;
  return { title: { absolute: name ? `${name} · Customer Portal` : "Customer Portal" } };
}

/**
 * The customer portal shell for one trucking company: its own name, logo and colour. It is not the Taviron app — no
 * company navigation, no staff controls. "Powered by Taviron" is the only platform mark.
 */
export default async function PortalLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await portalGate(slug);
  const company = gate.kind === "customer" ? gate.context : gate.company;
  const preview = gate.kind === "customer" ? await portalPreview(slug) : null;
  const style = company ? brandingStyle({ logo: company.logo, color: company.color, sidebarColor: "" }) : {};
  return (
    <div className="app-root min-h-dvh bg-surface text-ink" style={style}>
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-3 px-4">
          <Link href={`/portal/${slug}`} className="flex min-w-0 items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-strong">
            {/* The logo or the name, not both (owner 2026-10-26): a logo already carries the company's name. */}
            {company?.logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL from the company's settings
              <img src={company.logo} alt={company.name} className="h-11 w-auto max-w-[13rem] object-contain object-left" />
            ) : (
              <>
                {company?.name ? (
                  <span aria-hidden className="flex size-9 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white">
                    {company.name.slice(0, 1)}
                  </span>
                ) : null}
                <span className="truncate text-base font-semibold text-ink">{company?.name ?? "Customer Portal"}</span>
              </>
            )}
          </Link>
          {gate.kind === "customer" && !preview ? (
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden truncate text-sm text-muted sm:inline">{gate.context.customer.name}</span>
              <form action={signOutOfPortal}>
                <input type="hidden" name="slug" value={slug} />
                <button type="submit" className="rounded-xl px-2 py-1 text-sm font-semibold text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-strong">
                  Sign out
                </button>
              </form>
            </div>
          ) : null}
        </div>
        {gate.kind === "customer" ? <PortalNav slug={slug} features={gate.context.features} /> : null}
      </header>
      {preview ? (
        <div role="status" className="flex flex-wrap items-center justify-center gap-3 bg-strong px-4 py-2 text-center text-sm text-white">
          <span>Testing Lab preview: you are seeing what <strong>{preview.customer}</strong> sees. You have not signed in as them.</span>
          <form action={stopPortalPreview}>
            <button type="submit" className="rounded border border-white/60 px-2 py-0.5 font-semibold hover:bg-white/10">End Preview</button>
          </form>
        </div>
      ) : null}
      {company?.is_demo ? (
        <p className="bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">Demo portal: fictional company and records. Nothing here is sent or charged.</p>
      ) : null}
      <main id="main" className="mx-auto w-full max-w-5xl px-4 py-6 sm:py-8">
        {children}
      </main>
      <footer className="mx-auto w-full max-w-5xl px-4 pb-8 text-xs text-muted">
        <a href="https://mytaviron.com/" className="hover:text-ink hover:underline">Powered by Taviron</a>
      </footer>
    </div>
  );
}

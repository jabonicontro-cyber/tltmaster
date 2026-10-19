import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TavironLogo } from "@/components/site/logo";
import { safeNextPath } from "@/lib/safe-redirect";
import { publicSiteEnabled, siteGate } from "@/server/site-access";
import { hasSiteAccess } from "@/server/site-access-request";
import { EarlyAccessForm } from "./early-access-form";

export const metadata: Metadata = { title: "Early Access", robots: { index: false, follow: false } };

/**
 * The first page a visitor sees while Taviron is in early access (the proxy
 * sends every page here until this browser is admitted). Taviron's own brand,
 * always light-on-navy whatever the app theme. No implementation details.
 */
export default async function EarlyAccessPage({ searchParams }: { searchParams: Promise<{ next?: string; left?: string }> }) {
  const { next, left } = await searchParams;
  // Nothing to enter when the gate is off, or when this browser is already admitted.
  if (!siteGate().enabled || (await hasSiteAccess())) redirect(safeNextPath(next, "/login"));
  const site = publicSiteEnabled();
  return (
    <div className="site relative flex min-h-dvh flex-col overflow-hidden bg-navy text-cloud">
      <div className="site-grid-bg pointer-events-none absolute inset-0" aria-hidden />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(55%_60%_at_50%_0%,rgb(22_139_255/0.16),transparent)]" aria-hidden />

      <header className="relative mx-auto flex w-full max-w-6xl items-center px-4 pt-6 sm:px-6">
        {site ? (
          <Link href="/" className="rounded" aria-label="Taviron home">
            <TavironLogo />
          </Link>
        ) : (
          <TavironLogo />
        )}
      </header>

      <main id="main" className="relative flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          <p className="text-xs font-semibold tracking-[0.2em] text-electric uppercase">Early Access</p>
          <h1 className="mt-4 text-3xl leading-tight font-bold tracking-tight text-balance text-cloud sm:text-4xl">Taviron is open by invitation.</h1>
          <p className="mt-4 text-[15px] leading-relaxed text-silver">
            Operations software for aggregate and material haulers — quotes, orders, dispatch, drivers, delivery tickets and billing readiness in one place. Enter
            the Early Access password you received to continue.
          </p>

          {left ? (
            <p role="status" className="mt-6 rounded-lg border border-silver/15 bg-navy-2 px-4 py-3 text-sm text-silver">
              Early access was removed from this browser.
            </p>
          ) : null}

          <div className="mt-8 rounded-xl border border-silver/15 bg-navy-2/80 p-5 shadow-2xl shadow-black/30 backdrop-blur sm:p-6">
            <EarlyAccessForm next={next} />
          </div>

          <div className="mt-6 space-y-2 text-sm text-silver/85">
            <p>Don&apos;t have the password? Ask the person who invited you.</p>
            <p>Invited by your company? Open the link in your invitation email — it works without a password.</p>
            {site ? (
              <p>
                New to Taviron?{" "}
                <Link href="/demo" className="rounded font-semibold text-electric hover:underline">
                  Request a demo
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      </main>

      <footer className="relative mx-auto w-full max-w-6xl px-4 pb-6 text-xs text-silver/60 sm:px-6">Taviron · Early access</footer>
    </div>
  );
}

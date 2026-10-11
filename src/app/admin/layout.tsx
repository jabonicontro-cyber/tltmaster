import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { requirePlatformAdmin } from "@/server/platform";
import { signOut } from "@/app/(auth)/actions";

export const metadata: Metadata = { title: { default: "Platform", template: "%s · Platform · Taviron" } };

const NAV = [
  { href: "/admin", label: "Launchpad" },
  { href: "/admin/leads", label: "Leads" },
  { href: "/admin/demo", label: "Live demo" },
  { href: "/admin/onboarding", label: "Onboarding" },
  { href: "/admin/platform", label: "Administration" },
];

// The Taviron team's private area. Not linked from the public site; anyone who
// is not a platform admin gets "not found".
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await requirePlatformAdmin();
  return (
    <div className="min-h-dvh bg-surface">
      <header className="bg-charcoal">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/admin">
              <BrandMark />
            </Link>
            <span className="rounded bg-brand px-2 py-0.5 text-xs font-bold tracking-wide text-white">PLATFORM</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-white/70">
            <span className="hidden sm:inline">{me.email}</span>
            <Link href="/command-center" className="font-semibold text-white hover:underline">
              Open the app
            </Link>
            <form action={signOut}>
              <button className="font-semibold text-white/80 hover:text-white hover:underline">Sign out</button>
            </form>
          </div>
        </div>
        <nav aria-label="Platform" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-2 sm:px-4">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-t-md px-3 py-2 text-sm font-semibold whitespace-nowrap text-white/75 hover:bg-white/10 hover:text-white">
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

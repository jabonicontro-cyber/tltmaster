import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { requirePlatformAdmin } from "@/server/platform";
import { signOut } from "@/app/(auth)/actions";
import { AdminNav } from "@/components/admin/admin-nav";

export const metadata: Metadata = { title: { default: "Platform", template: "%s · Platform · Taviron" } };


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
        <AdminNav />
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

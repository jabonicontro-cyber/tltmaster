import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { requirePlatformAdmin } from "@/server/platform";
import { AdminNav } from "@/components/admin/admin-nav";
import { AdminUserMenu } from "@/components/admin/admin-user-menu";
import { PLATFORM_ROLE_TITLE, getMyProfile, photoUrl } from "@/server/data/profile";

export const metadata: Metadata = { title: { default: "Platform", template: "%s · Platform · Taviron" } };


// The Taviron team's private area. Not linked from the public site; anyone who
// is not a platform admin gets "not found".
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await requirePlatformAdmin();
  const profile = await getMyProfile();
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
          <AdminUserMenu name={profile?.displayName || profile?.fullName || ""} email={me.email} photo={profile ? photoUrl(profile.userId, profile.photoUpdatedAt) : ""} roleTitle={PLATFORM_ROLE_TITLE} />
        </div>
        <AdminNav />
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

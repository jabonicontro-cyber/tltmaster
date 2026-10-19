import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { cn } from "@/lib/cn";
import { APP_CONTAINER } from "@/lib/layout";
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
        <div className={cn(APP_CONTAINER, "flex h-16 items-center justify-between gap-3")}>
          <Link href="/admin" className="flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60">
            <BrandMark badge="Platform" />
            <span className="sr-only"> — Launchpad</span>
          </Link>
          <AdminUserMenu name={profile?.displayName || profile?.fullName || ""} email={me.email} photo={profile ? photoUrl(profile.userId, profile.photoUpdatedAt) : ""} roleTitle={PLATFORM_ROLE_TITLE} />
        </div>
        <AdminNav />
      </header>
      <main id="main" className={cn(APP_CONTAINER, "py-6")}>
        {children}
      </main>
    </div>
  );
}

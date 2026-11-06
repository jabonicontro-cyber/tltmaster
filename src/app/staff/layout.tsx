import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { cn } from "@/lib/cn";
import { APP_CONTAINER } from "@/lib/layout";
import { requirePlatformStaff } from "@/server/platform";
import { AdminNav } from "@/components/admin/admin-nav";
import { AdminUserMenu } from "@/components/admin/admin-user-menu";
import { getMyProfile, photoUrl, staffRoleTitle } from "@/server/data/profile";

export const metadata: Metadata = { title: { default: "Company access", template: "%s · Platform · Taviron" } };

// The Taviron team's company access desk (SA1): both staff levels. Same frame as the platform console; Support staff
// see this desk only. Anyone else gets "not found".
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const me = await requirePlatformStaff();
  const profile = await getMyProfile();
  return (
    <div className="min-h-dvh bg-surface">
      <header className="bg-charcoal">
        <div className={cn(APP_CONTAINER, "flex h-16 items-center justify-between gap-3")}>
          <Link href={me.level === "admin" ? "/admin" : "/staff"} className="flex rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60">
            <BrandMark badge="Platform" />
            <span className="sr-only">, {me.level === "admin" ? "Launchpad" : "Company access"}</span>
          </Link>
          <AdminUserMenu name={profile?.displayName || profile?.fullName || ""} email={me.email} photo={profile ? photoUrl(profile.userId, profile.photoUpdatedAt) : ""} roleTitle={staffRoleTitle(me.level)} profileHref="/staff/profile" />
        </div>
        <AdminNav level={me.level} />
      </header>
      <main id="main" className={cn(APP_CONTAINER, "py-8")}>
        {children}
      </main>
    </div>
  );
}

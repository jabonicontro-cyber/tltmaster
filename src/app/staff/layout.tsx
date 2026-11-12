import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requirePlatformStaff } from "@/server/platform";
import { ConsoleShell } from "@/components/admin/ui/shell";
import { getMyProfile, photoUrl, staffRoleTitle } from "@/server/data/profile";

export const metadata: Metadata = { title: { default: "Company access", template: "%s · Platform · Taviron" } };

// The Taviron team's company access desk (SA1): both staff levels. Same frame as the platform console; Support staff
// see this desk only. Anyone else gets "not found".
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const me = await requirePlatformStaff();
  const profile = await getMyProfile();
  const user = {
    name: profile?.displayName || profile?.fullName || "",
    email: me.email,
    photo: profile ? photoUrl(profile.userId, profile.photoUpdatedAt) : "",
    roleTitle: staffRoleTitle(me.level),
    profileHref: "/staff/profile",
  };
  return (
    <ConsoleShell level={me.level === "admin" ? "admin" : "support"} user={user}>
      {children}
    </ConsoleShell>
  );
}

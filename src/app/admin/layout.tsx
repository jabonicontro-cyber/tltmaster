import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/server/platform";
import { ConsoleShell } from "@/components/admin/ui/shell";
import { PLATFORM_ROLE_TITLE, getMyProfile, photoUrl } from "@/server/data/profile";

export const metadata: Metadata = { title: { default: "Platform", template: "%s · Platform · Taviron" } };

// The Taviron team's private area. Not linked from the public site; anyone who
// is not a platform admin gets "not found".
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await requirePlatformAdmin();
  const profile = await getMyProfile();
  const user = { name: profile?.displayName || profile?.fullName || "", email: me.email, photo: profile ? photoUrl(profile.userId, profile.photoUpdatedAt) : "", roleTitle: PLATFORM_ROLE_TITLE };
  return (
    <ConsoleShell level="admin" user={user}>
      {children}
    </ConsoleShell>
  );
}

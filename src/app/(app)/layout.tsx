import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { PRESENTATION_COOKIE } from "@/lib/platform/preview";
import { AppShell, type ShellBranding } from "@/components/layout/app-shell";
import { SIDEBAR_COOKIE } from "@/components/layout/sidebar-cookie";
import { requireAccess } from "@/server/auth";
import { myCompanies } from "@/server/data/companies";
import { getSettings } from "@/server/data/settings";
import { getDemoPersona, getMyProfile, photoUrl } from "@/server/data/profile";
import { avatarUrl } from "@/lib/people/avatars";
import { effectivePresence } from "@/lib/communications";
import { can } from "@/lib/permissions";
import { isPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const access = await requireAccess();
  const [companies, platformAdmin, profile, persona, branding] = await Promise.all([
    myCompanies(),
    isPlatformAdmin(),
    getMyProfile(),
    getDemoPersona(Boolean(access.isDemo), access.userId),
    // The company's own branding (row-level security); the default look when it cannot be read.
    getSettings().then(
      (s): ShellBranding => ({ color: s.brand_color, sidebarColor: s.brand_sidebar_color, logoUrl: s.has_logo ? `/brand/logo?c=${access.companyId}&v=${encodeURIComponent(s.updated_at)}` : "" }),
      (): ShellBranding => ({ color: "", sidebarColor: "", logoUrl: "" }),
    ),
  ]);
  // Own employee avatar (fallback when there is no profile photo) and whether this login drives.
  const supabase = await createClient();
  const [ownEmployee, ownDriver, ownPresence, commSettings] = await Promise.all([
    supabase.from("employees").select("avatar_key").eq("user_id", access.userId).maybeSingle(),
    supabase.from("drivers").select("id").eq("user_id", access.userId).eq("active", true).maybeSingle(),
    // Own presence for the dot on the profile picture (Communications; absent until it is installed).
    supabase.from("user_presence").select("manual_status, last_active_at").eq("company_id", access.companyId).eq("user_id", access.userId).maybeSingle(),
    supabase.from("comm_settings").select("away_after_minutes").eq("company_id", access.companyId).maybeSingle(),
  ]);
  const presence = can(access, "comms.message") && !ownPresence.error
    ? effectivePresence(ownPresence.data as { manual_status: string | null; last_active_at: string | null } | null,
        (commSettings.data as { away_after_minutes?: number } | null)?.away_after_minutes ?? 15)
    : undefined;
  const ownAvatar = avatarUrl((ownEmployee.data as { avatar_key?: string } | null)?.avatar_key);
  const hideMyDay = !ownDriver.data && !ownDriver.error && access.permissions.some((p) => p !== "driver.portal" && /^(dispatch|tickets|billing|fleet|orders|quotes)\.view$/.test(p));
  // Presentation mode only ever applies inside a demo company.
  const jar = await cookies();
  const presentation = access.isDemo && jar.get(PRESENTATION_COOKIE)?.value === "1";
  const sidebarPinned = jar.get(SIDEBAR_COOKIE)?.value === "pinned";
  return <AppShell access={access} companies={companies} platformAdmin={platformAdmin} presentation={presentation} sidebarPinned={sidebarPinned} me={persona ? { name: persona.name, photo: avatarUrl(persona.avatarKey), presence } : profile ? { name: profile.displayName || profile.fullName, photo: photoUrl(profile.userId, profile.photoUpdatedAt) || ownAvatar, presence } : null} branding={branding} hideMyDay={!persona && hideMyDay}>{children}</AppShell>;
}

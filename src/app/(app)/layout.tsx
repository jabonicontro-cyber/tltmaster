import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { after } from "next/server";
import { DEMO_WELCOME_COOKIE, PRESENTATION_COOKIE, welcomeToken, welcomedInCookie } from "@/lib/platform/preview";
import { AppShell, type ShellBranding } from "@/components/layout/app-shell";
import { SIDEBAR_COOKIE } from "@/components/layout/sidebar-cookie";
import { requireAccess } from "@/server/auth";
import { myCompanies } from "@/server/data/companies";
import { getSettings } from "@/server/data/settings";
import { PLATFORM_ROLE_TITLE, getDemoPersona, getMyProfile } from "@/server/data/profile";
import { personPhoto } from "@/lib/people/avatars";
import { effectivePresence } from "@/lib/communications";
import { can } from "@/lib/permissions";
import { isPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";
import { autoRefreshDemo } from "@/server/demo/auto-refresh";

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
  // Demos refresh their sample data themselves, after the page is sent (once per deployment and per day; the database
  // decides and only for the demo's owner). Never in a real company.
  if (access.isDemo) after(() => autoRefreshDemo(supabase).catch(() => undefined));
  const [ownEmployee, ownDriver, ownPresence, commSettings, welcomed] = await Promise.all([
    supabase.from("employees").select("avatar_key").eq("user_id", access.userId).maybeSingle(),
    supabase.from("drivers").select("id").eq("user_id", access.userId).eq("active", true).maybeSingle(),
    // Own presence for the dot on the profile picture (Communications; absent until it is installed).
    supabase.from("user_presence").select("manual_status, last_active_at").eq("company_id", access.companyId).eq("user_id", access.userId).maybeSingle(),
    supabase.from("comm_settings").select("away_after_minutes").eq("company_id", access.companyId).maybeSingle(),
    // Demo welcome already seen in this demo company (own row only, row-level security).
    access.isDemo ? supabase.from("user_preferences").select("key").eq("key", "demo_welcome").maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const presence = can(access, "comms.message") && !ownPresence.error
    ? effectivePresence(ownPresence.data as { manual_status: string | null; last_active_at: string | null } | null,
        (commSettings.data as { away_after_minutes?: number } | null)?.away_after_minutes ?? 15)
    : undefined;
  const ownAvatarKey = (ownEmployee.data as { avatar_key?: string } | null)?.avatar_key ?? "";
  const hideMyDay = !ownDriver.data && !ownDriver.error && access.permissions.some((p) => p !== "driver.portal" && /^(dispatch|tickets|billing|fleet|orders|quotes)\.view$/.test(p));
  // Presentation mode only ever applies inside a demo company.
  const jar = await cookies();
  const presentation = access.isDemo && jar.get(PRESENTATION_COOKIE)?.value === "1";
  const sidebarPinned = jar.get(SIDEBAR_COOKIE)?.value === "pinned";
  // The demo welcome shows until this person dismisses it in this demo company (never in presentation mode).
  const welcome = Boolean(access.isDemo && !presentation && access.companyId && !welcomed.data &&
    !welcomedInCookie(jar.get(DEMO_WELCOME_COOKIE)?.value, welcomeToken(access.companyId, access.userId)));
  // The header picture follows the same order as every other page (personPhoto): the person's own profile photo,
  // else the illustrated avatar on their employee record, else initials. In a demo the persona supplies the name only.
  // The Taviron platform team is always shown as themselves — own photo (else initials) and own name, with the role
  // "Taviron Administrator" — in every company and demo, never as a demo persona. Display only: permissions are unchanged.
  const shownPersona = platformAdmin ? null : persona;
  const picture = platformAdmin ? personPhoto(access.userId, profile?.photoUpdatedAt, "") : personPhoto(access.userId, profile?.photoUpdatedAt, persona?.avatarKey || ownAvatarKey);
  const me = shownPersona || profile ? { name: shownPersona?.name || profile?.displayName || profile?.fullName || access.fullName || "", photo: picture.src, fallbackPhoto: picture.fallbackSrc, presence } : null;
  return <AppShell access={access} companies={companies} platformAdmin={platformAdmin} roleTitle={platformAdmin ? PLATFORM_ROLE_TITLE : undefined} presentation={presentation} welcome={welcome} sidebarPinned={sidebarPinned} me={me} branding={branding} hideMyDay={!persona && hideMyDay}>{children}</AppShell>;
}

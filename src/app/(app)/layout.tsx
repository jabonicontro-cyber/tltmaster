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
import { isPlatformAdmin } from "@/server/platform";

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
  // Presentation mode only ever applies inside a demo company.
  const jar = await cookies();
  const presentation = access.isDemo && jar.get(PRESENTATION_COOKIE)?.value === "1";
  const sidebarPinned = jar.get(SIDEBAR_COOKIE)?.value === "pinned";
  return <AppShell access={access} companies={companies} platformAdmin={platformAdmin} presentation={presentation} sidebarPinned={sidebarPinned} me={persona ? { name: persona.name, photo: avatarUrl(persona.avatarKey) } : profile ? { name: profile.displayName || profile.fullName, photo: photoUrl(profile.userId, profile.photoUpdatedAt) } : null} branding={branding}>{children}</AppShell>;
}

import type { ReactNode } from "react";
import { AppShell, type ShellBranding } from "@/components/layout/app-shell";
import { requireAccess } from "@/server/auth";
import { myCompanies } from "@/server/data/companies";
import { getSettings } from "@/server/data/settings";
import { isPlatformAdmin } from "@/server/platform";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const access = await requireAccess();
  const [companies, platformAdmin, branding] = await Promise.all([
    myCompanies(),
    isPlatformAdmin(),
    // The company's own branding (row-level security); the default look when it cannot be read.
    getSettings().then(
      (s): ShellBranding => ({ color: s.brand_color, sidebarColor: s.brand_sidebar_color, logoUrl: s.has_logo ? `/brand/logo?c=${access.companyId}&v=${encodeURIComponent(s.updated_at)}` : "" }),
      (): ShellBranding => ({ color: "", sidebarColor: "", logoUrl: "" }),
    ),
  ]);
  return <AppShell access={access} companies={companies} platformAdmin={platformAdmin} branding={branding}>{children}</AppShell>;
}

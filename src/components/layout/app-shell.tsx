import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { CompanyIdentity } from "./company-identity";
import { DesktopSidebar } from "./desktop-sidebar";
import { ListViewRecorder } from "@/components/nav/nav-memory";
import { UnsavedChangesGuard } from "@/components/nav/unsaved-guard";
import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import { DemoBar } from "./demo-bar";
import { ROLE_LABELS, type Access } from "@/lib/permissions";
import type { MyCompany } from "@/server/data/companies";
import { brandingStyle } from "@/lib/branding";

export interface ShellBranding {
  color: string;
  sidebarColor: string;
  logoUrl: string; // "" when the company has no logo
}

/**
 * The company workspace. The company's identity and colors come first (logo or
 * name top-left, its accent and navigation colors via CSS variables); Taviron
 * is a quiet "Powered by Taviron" line. Urgency colors are fixed ("critical")
 * and never follow a company's colors.
 */
export function AppShell({ access, companies = [], platformAdmin = false, presentation = false, sidebarPinned = false, me = null, branding, hideMyDay = false, children }: { access: Access; companies?: MyCompany[]; platformAdmin?: boolean; presentation?: boolean; sidebarPinned?: boolean; /** Display name and photo from the person's own profile, when available. */ me?: { name: string; photo: string } | null; branding?: ShellBranding; /** Hide My Day: the login is not a driver but has other work (owners, office). */ hideMyDay?: boolean; children: ReactNode }) {
  const style = branding ? brandingStyle({ logo: "", color: branding.color, sidebarColor: branding.sidebarColor }) : {};
  const logoUrl = branding?.logoUrl ?? "";
  // Navigation only (pages still check real permissions): no My Day entry for people who do not drive.
  const navPermissions = hideMyDay ? access.permissions.filter((p) => p !== "driver.portal") : access.permissions;
  return (
    <div className="app-root min-h-dvh lg:pl-[4.5rem] lg:data-[sidebar=pinned]:pl-64" data-sidebar={sidebarPinned ? "pinned" : "rail"} style={style}>
      <Suspense fallback={null}><ListViewRecorder /></Suspense>
      <UnsavedChangesGuard />
      <DesktopSidebar permissions={navPermissions} companyName={access.companyName} logoUrl={logoUrl} initiallyPinned={sidebarPinned} />

      {access.isDemo && !presentation ? <DemoBar preview={access.preview ?? null} platformAdmin={platformAdmin} /> : null}
      <header className="no-print sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-card/95 px-3 backdrop-blur lg:px-6">
        <div className="flex min-w-0 items-center gap-1">
          <MobileNav permissions={navPermissions} companyName={access.companyName} logoUrl={logoUrl} />
          <Link href="/command-center" className="min-w-0 lg:hidden" aria-label={`${access.companyName ?? "Company"} — home`}>
            <CompanyIdentity name={access.companyName} logoUrl={logoUrl} tone="dark" />
          </Link>
        </div>
        <UserMenu
          name={me?.name || access.fullName}
          email={access.email}
          photo={me?.photo ?? ""}
          roleLabel={`${access.role ? ROLE_LABELS[access.role] : "No role"}${access.companyName ? ` · ${access.companyName}` : ""}`}
          companies={companies.map((c) => ({ id: c.company_id, name: c.name, current: c.current, role: ROLE_LABELS[c.role as keyof typeof ROLE_LABELS] ?? c.role }))}
          canCreateCompany={access.role === "owner"}
          demo={access.isDemo ? { presentation } : null}
          platformAdmin={platformAdmin}
        />
      </header>

      <main id="main" tabIndex={-1} className="outline-none mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

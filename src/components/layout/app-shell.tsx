import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { CompanyIdentity } from "./company-identity";
import { DesktopSidebar } from "./desktop-sidebar";
import { ListViewRecorder } from "@/components/nav/nav-memory";
import { UnsavedChangesGuard } from "@/components/nav/unsaved-guard";
import { MobileNav } from "./mobile-nav";
import { cn } from "@/lib/cn";
import { APP_CONTAINER } from "@/lib/layout";
import { DriverTabBar } from "@/components/companion/driver-tab-bar";
import { ServiceWorkerRegistration } from "@/components/companion/service-worker";
import { isDriverOnly, isMechanicOnly } from "@/lib/companion";
import { UserMenu } from "./user-menu";
import type { Presence } from "@/lib/communications";
import { DemoWelcome } from "./demo-welcome";
import { QuickSearch } from "./quick-search";
import { ROLE_LABELS, type Access } from "@/lib/permissions";
import type { MyCompany } from "@/server/data/companies";
import { brandingStyle } from "@/lib/branding";
import { HelpPanel } from "@/components/help/help-panel";
import { Search, Sparkles } from "lucide-react";
import { capability, mayUse } from "@/lib/ai/capabilities";
import { GuidePlayer } from "@/components/help/guide-player";
import { helpPanelData } from "@/server/help";

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
export function AppShell({ access, companies = [], platformAdmin = false, roleTitle, presentation = false, welcome = false, sidebarPinned = false, me = null, branding, hideMyDay = false, children }: { access: Access; companies?: MyCompany[]; platformAdmin?: boolean; /** Shown instead of the company role (the Taviron platform team). */ roleTitle?: string; presentation?: boolean; /** Demo company: show the one-time welcome. */ welcome?: boolean; sidebarPinned?: boolean; /** Display name and picture (photo, else the illustrated avatar) of the signed-in person. */ me?: { name: string; photo: string; fallbackPhoto?: string; presence?: Presence | null } | null; branding?: ShellBranding; /** Hide My Day: the login is not a driver but has other work (owners, office). */ hideMyDay?: boolean; children: ReactNode }) {
  const style = branding ? brandingStyle({ logo: "", color: branding.color, sidebarColor: branding.sidebarColor }) : {};
  const logoUrl = branding?.logoUrl ?? "";
  // Navigation only (pages still check real permissions): no My Day entry for people who do not drive.
  const navPermissions = hideMyDay ? access.permissions.filter((p) => p !== "driver.portal") : access.permissions;
  // Companion app (docs/COMPANION_APP.md): a driver-only login gets bottom tabs on a phone.
  const driverOnly = isDriverOnly(navPermissions);
  const mechanicOnly = !driverOnly && isMechanicOnly(navPermissions);
  return (
    <div className="app-root min-h-dvh lg:pl-[5.25rem] lg:data-[sidebar=pinned]:pl-[16.75rem]" data-sidebar={sidebarPinned ? "pinned" : "rail"} style={style}>
      <Suspense fallback={null}><ListViewRecorder /></Suspense>
      <UnsavedChangesGuard />
      <ServiceWorkerRegistration />
      <DesktopSidebar permissions={navPermissions} companyName={access.companyName} logoUrl={logoUrl} initiallyPinned={sidebarPinned} />

      {access.isDemo ? <DemoWelcome initiallyOpen={welcome} companyName={access.companyName} /> : null}
      <header className="app-header no-print sticky top-0 z-20 bg-surface/80 backdrop-blur-md">
        <div className={cn(APP_CONTAINER, "flex h-14 items-center justify-between gap-3")}>
          <div className="flex min-w-0 items-center gap-1">
            <MobileNav permissions={navPermissions} companyName={access.companyName} logoUrl={logoUrl} />
            {/* Shrinks with the header on narrow phones instead of running under the icons on the right. */}
            <Link href="/command-center" className="block min-w-0 max-w-40 lg:hidden">
              <CompanyIdentity name={access.companyName} logoUrl={logoUrl} tone="dark" className="max-w-full" />
              <span className="sr-only"> — home</span>
            </Link>
        </div>
        <div className="flex shrink-0 items-center gap-0 sm:gap-1">
        {/* Search as you type on wider screens (the most used way in); an icon to the Search page on phones. */}
        <QuickSearch />
        <Link href="/search" className="inline-flex size-10 items-center justify-center rounded-full text-muted hover:bg-card hover:text-ink focus-visible:outline-2 focus-visible:outline-strong md:hidden" aria-label="Search records">
          <Search className="size-5" aria-hidden />
        </Link>
        {/* Ask Taviron (docs/AI.md §12); not for driver-only logins, whose phone view stays free of distractions. */}
        {!driverOnly && mayUse(capability("ops_assistant"), navPermissions) && (
          <Link href="/assistant" className="inline-flex size-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-card hover:text-ink focus-visible:outline-2 focus-visible:outline-strong" aria-label="Ask Taviron">
            <Sparkles className="size-5" aria-hidden />
          </Link>
        )}
        <HelpPanel {...helpPanelData(access.permissions)} />
        <UserMenu
          name={me?.name || access.fullName}
          email={access.email}
          photo={me?.photo ?? ""}
          fallbackPhoto={me?.fallbackPhoto ?? ""}
          presence={me?.presence}
          roleLabel={`${roleTitle ?? (access.role ? ROLE_LABELS[access.role] : "No role")}${access.companyName ? ` · ${access.companyName}` : ""}`}
          companies={companies.map((c) => ({ id: c.company_id, name: c.name, current: c.current, role: ROLE_LABELS[c.role as keyof typeof ROLE_LABELS] ?? c.role }))}
          canCreateCompany={access.role === "owner"}
          canManageSettings={access.permissions.includes("settings.manage")}
          demo={access.isDemo ? { presentation, preview: access.preview ?? null } : null}
          platformAdmin={platformAdmin}
        />
        </div>
        </div>
      </header>
      <GuidePlayer />

      <main id="main" tabIndex={-1} className={cn(APP_CONTAINER, "outline-none py-6", (driverOnly || mechanicOnly) && "pb-32 md:pb-6")}>
        {children}
      </main>
      {driverOnly && <DriverTabBar permissions={navPermissions} />}
      {mechanicOnly && <DriverTabBar permissions={navPermissions} kind="mechanic" />}
    </div>
  );
}

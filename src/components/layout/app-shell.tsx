import type { ReactNode } from "react";
import Link from "next/link";
import { TavironEmblem } from "./brand";
import { CompanyIdentity } from "./company-identity";
import { MobileNav } from "./mobile-nav";
import { SidebarNav } from "./sidebar-nav";
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
export function AppShell({ access, companies = [], platformAdmin = false, presentation = false, branding, children }: { access: Access; companies?: MyCompany[]; platformAdmin?: boolean; presentation?: boolean; branding?: ShellBranding; children: ReactNode }) {
  const style = branding ? brandingStyle({ logo: "", color: branding.color, sidebarColor: branding.sidebarColor }) : {};
  const logoUrl = branding?.logoUrl ?? "";
  return (
    <div className="min-h-dvh lg:pl-64" style={style}>
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-charcoal lg:flex">
        <Link href="/command-center" className="flex h-16 shrink-0 items-center border-b border-white/10 px-4" aria-label={`${access.companyName ?? "Company"} — home`}>
          <CompanyIdentity name={access.companyName} logoUrl={logoUrl} />
        </Link>
        <div className="relative flex-1 overflow-y-auto py-3">
          <SidebarNav permissions={access.permissions} />
        </div>
        <p className="flex shrink-0 items-center gap-2 border-t border-white/10 px-4 py-3 text-xs text-white/55">
          <TavironEmblem className="size-4 opacity-80" /> Powered by Taviron
        </p>
      </aside>

      {access.isDemo && !presentation ? <DemoBar preview={access.preview ?? null} platformAdmin={platformAdmin} /> : null}
      <header className="no-print sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-white/95 px-3 backdrop-blur lg:px-6">
        <div className="flex min-w-0 items-center gap-1">
          <MobileNav permissions={access.permissions} companyName={access.companyName} logoUrl={logoUrl} />
          <Link href="/command-center" className="min-w-0 lg:hidden" aria-label={`${access.companyName ?? "Company"} — home`}>
            <CompanyIdentity name={access.companyName} logoUrl={logoUrl} tone="dark" />
          </Link>
        </div>
        <UserMenu
          name={access.fullName}
          email={access.email}
          roleLabel={`${access.role ? ROLE_LABELS[access.role] : "No role"}${access.companyName ? ` · ${access.companyName}` : ""}`}
          companies={companies.map((c) => ({ id: c.company_id, name: c.name, current: c.current, role: ROLE_LABELS[c.role as keyof typeof ROLE_LABELS] ?? c.role }))}
          canCreateCompany={access.role === "owner"}
          demo={access.isDemo ? { presentation } : null}
        />
      </header>

      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

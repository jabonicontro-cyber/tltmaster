import type { ReactNode } from "react";
import { PRODUCT_NAME } from "@/lib/product";
import Link from "next/link";
import { BrandMark } from "./brand";
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

/** The company's logo when it has one, otherwise the Taviron mark. */
function CompanyMark({ branding, companyName }: { branding?: ShellBranding; companyName: string | null }) {
  if (!branding?.logoUrl) return <BrandMark />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small per-company image served by our own route
    <img src={branding.logoUrl} alt={companyName ? `${companyName} — home` : "Company logo — home"} className="h-9 max-w-44 rounded-sm bg-white object-contain p-0.5" />
  );
}

export function AppShell({ access, companies = [], platformAdmin = false, branding, children }: { access: Access; companies?: MyCompany[]; platformAdmin?: boolean; branding?: ShellBranding; children: ReactNode }) {
  const style = branding ? brandingStyle({ logo: "", color: branding.color, sidebarColor: branding.sidebarColor }) : {};
  return (
    <div className="min-h-dvh lg:pl-68" style={style}>
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-68 flex-col bg-charcoal py-4 lg:flex">
        <Link href="/command-center" className="mb-6 px-5">
          <CompanyMark branding={branding} companyName={access.companyName} />
        </Link>
        <div className="relative flex-1 overflow-y-auto">
          <SidebarNav permissions={access.permissions} />
        </div>
        <p className="truncate px-5 pt-4 text-xs text-white/60" title={access.companyName ?? undefined}>
          {branding?.logoUrl || branding?.color || branding?.sidebarColor ? `${access.companyName ?? ""} · Powered by ${PRODUCT_NAME}` : `${PRODUCT_NAME}${access.companyName ? ` · ${access.companyName}` : ""}`}
        </p>
      </aside>

      {access.isDemo ? <DemoBar preview={access.preview ?? null} platformAdmin={platformAdmin} /> : null}
      <header className="no-print sticky top-0 z-20 flex h-14 items-center justify-between gap-3 bg-charcoal px-3 shadow-sm lg:bg-charcoal-2 lg:px-6">
        <div className="flex items-center gap-2">
          <MobileNav permissions={access.permissions} />
          <Link href="/command-center" className="lg:hidden">
            <CompanyMark branding={branding} companyName={access.companyName} />
          </Link>
        </div>
        <UserMenu name={access.fullName} email={access.email} roleLabel={`${access.role ? ROLE_LABELS[access.role] : "No role"}${access.companyName ? ` · ${access.companyName}` : ""}`} companies={companies.map((c) => ({ id: c.company_id, name: c.name, current: c.current, role: ROLE_LABELS[c.role as keyof typeof ROLE_LABELS] ?? c.role }))} canCreateCompany={access.role === "owner"} />
      </header>

      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

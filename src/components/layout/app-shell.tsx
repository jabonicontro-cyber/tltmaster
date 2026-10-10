import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "./brand";
import { MobileNav } from "./mobile-nav";
import { SidebarNav } from "./sidebar-nav";
import { UserMenu } from "./user-menu";
import { ROLE_LABELS, type Access } from "@/lib/permissions";
import type { MyCompany } from "@/server/data/companies";

export function AppShell({ access, companies = [], children }: { access: Access; companies?: MyCompany[]; children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:pl-68">
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-68 flex-col bg-charcoal py-4 lg:flex">
        <Link href="/dashboard" className="mb-6 px-5">
          <BrandMark />
        </Link>
        <div className="relative flex-1 overflow-y-auto">
          <SidebarNav permissions={access.permissions} />
        </div>
        <p className="px-5 pt-4 text-xs text-white/40">Top Line Trucking Manager</p>
      </aside>

      <header className="no-print sticky top-0 z-20 flex h-14 items-center justify-between gap-3 bg-charcoal px-3 shadow-sm lg:bg-charcoal-2 lg:px-6">
        <div className="flex items-center gap-2">
          <MobileNav permissions={access.permissions} />
          <Link href="/dashboard" className="lg:hidden">
            <BrandMark />
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

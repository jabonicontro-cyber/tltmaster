import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { requireAccess } from "@/server/auth";
import { myCompanies } from "@/server/data/companies";
import { isPlatformAdmin } from "@/server/platform";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const access = await requireAccess();
  const [companies, platformAdmin] = await Promise.all([myCompanies(), isPlatformAdmin()]);
  return <AppShell access={access} companies={companies} platformAdmin={platformAdmin}>{children}</AppShell>;
}

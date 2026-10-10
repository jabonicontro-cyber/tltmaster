import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { requireAccess } from "@/server/auth";
import { myCompanies } from "@/server/data/companies";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const access = await requireAccess();
  const companies = await myCompanies();
  return <AppShell access={access} companies={companies}>{children}</AppShell>;
}

import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { requireAccess } from "@/server/auth";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const access = await requireAccess();
  return <AppShell access={access}>{children}</AppShell>;
}

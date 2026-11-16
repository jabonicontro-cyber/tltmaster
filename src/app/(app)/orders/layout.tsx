import type { ReactNode } from "react";
import { ModuleGate } from "@/components/layout/module-gate";

// Workflow modules (MOD1, docs/MODULES.md): these pages open only while the company uses this module.
export default function Layout({ children }: { children: ReactNode }) {
  return <ModuleGate module="orders">{children}</ModuleGate>;
}

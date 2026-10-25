"use client";

import { Dialog as D } from "radix-ui";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { PoweredByTaviron } from "./powered-by-taviron";
import { CompanyIdentity } from "./company-identity";
import { SidebarNav } from "./sidebar-nav";
import type { Permission } from "@/lib/permissions";

export function MobileNav({ permissions, companyName, logoUrl }: { permissions: Permission[]; companyName: string | null; logoUrl: string }) {
  const [open, setOpen] = useState(false);
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger className="rounded-full p-2 text-ink hover:bg-card lg:hidden" aria-label="Open menu">
        <Menu className="size-6" />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="ui-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden" />
        <D.Content className="fixed inset-y-2 left-2 z-50 flex w-72 max-w-[85vw] flex-col rounded-[1.5rem] bg-charcoal shadow-float focus:outline-none lg:hidden">
          <D.Title className="sr-only">Main menu</D.Title>
          <D.Description className="sr-only">Navigate between sections</D.Description>
          <div className="flex h-16 items-center justify-between gap-2 px-4">
            <CompanyIdentity name={companyName} logoUrl={logoUrl} />
            <D.Close className="rounded p-1 text-white/80 hover:bg-white/10" aria-label="Close menu">
              <X className="size-6" />
            </D.Close>
          </div>
          <div className="relative flex-1 overflow-y-auto py-3">
            <SidebarNav permissions={permissions} onNavigate={() => setOpen(false)} />
          </div>
          <div className="px-2 pb-2">
            <PoweredByTaviron className="px-2 py-2" />
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

"use client";

import { Dialog as D } from "radix-ui";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { TavironEmblem } from "./brand";
import { CompanyIdentity } from "./company-identity";
import { SidebarNav } from "./sidebar-nav";
import type { Permission } from "@/lib/permissions";

export function MobileNav({ permissions, companyName, logoUrl }: { permissions: Permission[]; companyName: string | null; logoUrl: string }) {
  const [open, setOpen] = useState(false);
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger className="rounded-md p-2 text-ink hover:bg-surface lg:hidden" aria-label="Open menu">
        <Menu className="size-6" />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 lg:hidden" />
        <D.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-charcoal shadow-xl focus:outline-none lg:hidden">
          <D.Title className="sr-only">Main menu</D.Title>
          <D.Description className="sr-only">Navigate between sections</D.Description>
          <div className="flex h-16 items-center justify-between gap-2 border-b border-white/10 px-4">
            <CompanyIdentity name={companyName} logoUrl={logoUrl} />
            <D.Close className="rounded p-1 text-white/80 hover:bg-white/10" aria-label="Close menu">
              <X className="size-6" />
            </D.Close>
          </div>
          <div className="relative flex-1 overflow-y-auto py-3">
            <SidebarNav permissions={permissions} onNavigate={() => setOpen(false)} />
          </div>
          <p className="flex items-center gap-2 border-t border-white/10 px-4 py-3 text-xs text-white/55">
            <TavironEmblem className="size-4 opacity-80" /> Powered by Taviron
          </p>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

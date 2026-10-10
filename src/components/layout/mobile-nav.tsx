"use client";

import { Dialog as D } from "radix-ui";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "./brand";
import { SidebarNav } from "./sidebar-nav";
import type { Permission } from "@/lib/permissions";

export function MobileNav({ permissions }: { permissions: Permission[] }) {
  const [open, setOpen] = useState(false);
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger className="rounded-md p-2 text-white hover:bg-white/10 lg:hidden" aria-label="Open menu">
        <Menu className="size-6" />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 lg:hidden" />
        <D.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-charcoal py-4 shadow-xl focus:outline-none lg:hidden">
          <D.Title className="sr-only">Main menu</D.Title>
          <D.Description className="sr-only">Navigate between sections</D.Description>
          <div className="mb-4 flex items-center justify-between px-4">
            <BrandMark />
            <D.Close className="rounded p-1 text-white/80 hover:bg-white/10" aria-label="Close menu">
              <X className="size-6" />
            </D.Close>
          </div>
          <div className="relative flex-1 overflow-y-auto">
            <SidebarNav permissions={permissions} onNavigate={() => setOpen(false)} />
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

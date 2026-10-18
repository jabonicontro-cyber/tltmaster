"use client";

import { DropdownMenu as M } from "radix-ui";
import Link from "next/link";
import { useTransition } from "react";
import { AppWindow, ChevronDown, CircleUserRound, LogOut } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { signOut } from "@/app/(auth)/actions";

/** The platform console's account menu: the signed-in team member as themselves (own photo, else initials). */
export function AdminUserMenu({ name, email, photo, roleTitle }: { name: string; email: string; photo: string; roleTitle: string }) {
  const [signingOut, startSignOut] = useTransition();
  const shown = name || email;
  return (
    <M.Root>
      <M.Trigger aria-label={`Account menu: ${shown}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-white hover:bg-white/10">
        <Avatar key={photo} name={shown} src={photo} size={32} />
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-[14rem] truncate text-sm font-semibold">{shown}</span>
          <span className="block max-w-[14rem] truncate text-xs text-white/70">{roleTitle}</span>
        </span>
        <ChevronDown className="size-4 text-white/70" aria-hidden />
      </M.Trigger>
      <M.Portal>
        <M.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-md border border-line bg-card p-1 text-ink shadow-lg">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-semibold">{shown}</p>
            <p className="truncate text-xs text-muted">{roleTitle}</p>
            <p className="truncate text-xs text-muted">{email}</p>
          </div>
          <M.Separator className="my-1 h-px bg-line" />
          <M.Item asChild>
            <Link href="/admin/profile" className="flex items-center gap-2 rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface">
              <CircleUserRound className="size-4 text-muted" aria-hidden /> My profile
            </Link>
          </M.Item>
          <M.Item asChild>
            <Link href="/command-center" className="flex items-center gap-2 rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface">
              <AppWindow className="size-4 text-muted" aria-hidden /> Open the app
            </Link>
          </M.Item>
          <M.Separator className="my-1 h-px bg-line" />
          <M.Item
            disabled={signingOut}
            onSelect={(e) => { e.preventDefault(); startSignOut(() => signOut()); }}
            className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface"
          >
            <LogOut className="size-4 text-muted" aria-hidden /> {signingOut ? "Signing out…" : "Sign out"}
          </M.Item>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

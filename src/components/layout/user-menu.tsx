"use client";

import { DropdownMenu as M } from "radix-ui";
import { ChevronDown, LogOut, UserRound } from "lucide-react";
import { signOut } from "@/app/(auth)/actions";

export function UserMenu({ name, email, roleLabel }: { name: string; email: string; roleLabel: string }) {
  return (
    <M.Root>
      <M.Trigger className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-white hover:bg-white/10">
        <span className="flex size-8 items-center justify-center rounded-full bg-white/15">
          <UserRound className="size-4" aria-hidden />
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-[12rem] truncate text-sm font-semibold">{name || email}</span>
          <span className="block text-xs text-white/60">{roleLabel}</span>
        </span>
        <ChevronDown className="size-4 text-white/60" aria-hidden />
      </M.Trigger>
      <M.Portal>
        <M.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-md border border-line bg-white p-1 shadow-lg">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-semibold text-ink">{name || "Signed in"}</p>
            <p className="truncate text-xs text-muted">{email}</p>
          </div>
          <M.Separator className="my-1 h-px bg-line" />
          <form action={signOut}>
            <M.Item asChild>
              <button type="submit" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface">
                <LogOut className="size-4" aria-hidden />
                Sign out
              </button>
            </M.Item>
          </form>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

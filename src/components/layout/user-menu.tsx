"use client";

import { DropdownMenu as M } from "radix-ui";
import Link from "next/link";
import { Building2, Check, ChevronDown, LogOut, Plus, UserRound } from "lucide-react";
import { useTransition } from "react";
import { signOut } from "@/app/(auth)/actions";
import { switchCompany } from "@/app/account/actions";

type CompanyItem = { id: string; name: string; current: boolean; role: string };

export function UserMenu({ name, email, roleLabel, companies = [], canCreateCompany = false }: { name: string; email: string; roleLabel: string; companies?: CompanyItem[]; canCreateCompany?: boolean }) {
  const [signingOut, startSignOut] = useTransition();
  const [switching, startSwitch] = useTransition();
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
          {companies.length > 1 && (
            <>
              <M.Label className="px-3 pt-1 pb-1 text-xs font-semibold text-muted uppercase">Companies</M.Label>
              {companies.map((c) => (
                <M.Item
                  key={c.id}
                  disabled={c.current || switching}
                  onSelect={() => startSwitch(async () => { await switchCompany(c.id); })}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface data-[disabled]:cursor-default"
                  aria-label={`Switch to ${c.name}`}
                >
                  {c.current ? <Check className="size-4 text-brand" aria-hidden /> : <Building2 className="size-4 text-muted" aria-hidden />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{c.name}</span>
                    <span className="block text-xs text-muted">{c.role}{c.current ? " · current" : ""}</span>
                  </span>
                </M.Item>
              ))}
              <M.Separator className="my-1 h-px bg-line" />
            </>
          )}
          {canCreateCompany && (
            <M.Item asChild className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface">
              <Link href="/onboarding"><Plus className="size-4" aria-hidden /> Create a company</Link>
            </M.Item>
          )}
          {/* Call the action directly: a <form> inside the menu would unmount before it submits. */}
          <M.Item
            disabled={signingOut}
            onSelect={() => startSignOut(() => signOut())}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface data-[disabled]:opacity-60"
          >
            <LogOut className="size-4" aria-hidden />
            {signingOut ? "Signing out…" : "Sign out"}
          </M.Item>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

"use client";

import { DropdownMenu as M } from "radix-ui";
import Link from "next/link";
import { Building2, Check, ChevronDown, CircleUserRound, Info, ListChecks, LogOut, MonitorPlay, Plus, ShieldCheck, UsersRound } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { PresenceDot } from "@/components/communications/status";
import type { Presence } from "@/lib/communications";
import { THEME_OPTIONS, applyTheme, parseTheme } from "@/lib/theme";
import { useThemePreference } from "@/components/ui/theme-sync";
import { usePathname } from "next/navigation";
import { setPresentationMode } from "@/app/(app)/demo-actions";
import { PREVIEW_LABELS, parsePreviewRole } from "@/lib/platform/preview";
import { ChangeViewDialog } from "./change-view-dialog";
import { OPEN_DEMO_WELCOME } from "./demo-welcome";
import { useState, useTransition } from "react";
import { signOut } from "@/app/(auth)/actions";
import { switchCompany } from "@/app/account/actions";

type CompanyItem = { id: string; name: string; current: boolean; role: string };

export function UserMenu({ name, email, photo = "", fallbackPhoto = "", roleLabel, companies = [], canCreateCompany = false, canManageSettings = false, demo = null, platformAdmin = false, presence }: { name: string; email: string; photo?: string; /** Shown when there is no photo or it fails (the employee record's illustrated avatar). */ fallbackPhoto?: string; /** Undefined: Communications not available to this user (no dot). */ presence?: Presence | null; roleLabel: string; companies?: CompanyItem[]; canCreateCompany?: boolean; /** Company setup checklist (settings.manage; the page checks it again). */ canManageSettings?: boolean; /** In a demo company: presentation mode and the current role preview (null = own view). */ demo?: { presentation: boolean; preview: string | null } | null; platformAdmin?: boolean }) {
  const [signingOut, startSignOut] = useTransition();
  const [toggling, startToggle] = useTransition();
  const pathname = usePathname();
  const togglePresentation = () =>
    startToggle(async () => {
      const fd = new FormData();
      fd.set("on", demo?.presentation ? "0" : "1");
      fd.set("next", pathname);
      await setPresentationMode(fd);
    });
  const [switching, startSwitch] = useTransition();
  // Change view (demo only): a dialog over the existing role preview, which only ever narrows real permissions.
  const [viewOpen, setViewOpen] = useState(false);
  const currentView = parsePreviewRole(demo?.preview);
  const theme = useThemePreference();
  return (
    <>
      <M.Root>
        <M.Trigger className="flex items-center gap-1.5 rounded-full py-1 pr-1 pl-1 text-left text-ink transition-colors hover:bg-card sm:gap-2 sm:pr-2.5">
          {/* Spoken name starts with what is shown (the person's name), not a hidden aria-label (WCAG 2.5.3). */}
          <span className="sr-only">Account menu: {name || email}{demo && !demo.presentation ? " (demo company)" : ""}</span>
          <span className="relative shrink-0">
            {/* Keyed by the picture so a new photo (or another person) never shows a stale image or failure. */}
            <Avatar key={`${photo}|${fallbackPhoto}`} name={name || email} src={photo} fallbackSrc={fallbackPhoto} size={32} />
            {presence !== undefined && <PresenceDot presence={presence} className="absolute -right-0.5 -bottom-0.5" />}
          </span>
          <span className="hidden min-w-0 sm:block" aria-hidden>
            <span className="block max-w-[12rem] truncate text-sm font-semibold">{name || email}</span>
            <span className="block max-w-[16rem] truncate text-xs text-muted">{roleLabel}</span>
          </span>
          {demo && !demo.presentation && (
            <span aria-hidden className="inline-flex h-5 items-center rounded-full bg-surface px-2 text-[11px] font-semibold text-muted ring-1 ring-line" title="Demo company: fictional data, nothing is sent">
              <span className="pill-text">Demo{currentView ? <span className="hidden sm:inline"> · {PREVIEW_LABELS[currentView]}</span> : null}</span>
            </span>
          )}
          {/* The picture is the button on phones; the arrow returns where there is room. */}
          <ChevronDown className="hidden size-4 text-muted sm:block" aria-hidden />
        </M.Trigger>
        <M.Portal>
          <M.Content align="end" sideOffset={6} onCloseAutoFocus={(e) => { if (viewOpen) e.preventDefault(); }} className="ui-pop z-50 min-w-56 origin-top-right rounded-2xl border border-line/70 bg-card p-1.5 shadow-float">
            <div className="px-3 py-2">
              <p className="truncate text-sm font-semibold text-ink">{name || "Signed in"}</p>
              <p className="truncate text-xs text-muted">{email}</p>
              {demo && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                  <Info className="size-3.5 shrink-0" aria-hidden /> Demo company · fictional data · nothing is sent
                </p>
              )}
            </div>
            <M.Item asChild className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface">
              <Link href="/profile"><CircleUserRound className="size-4" aria-hidden /> My profile</Link>
            </M.Item>
            {canManageSettings && (
              <M.Item asChild className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface">
                <Link href="/setup"><ListChecks className="size-4" aria-hidden /> Company setup</Link>
              </M.Item>
            )}
            {demo && (
              <M.Item
                onSelect={() => setViewOpen(true)}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface"
              >
                <UsersRound className="size-4" aria-hidden />
                <span className="flex-1">Change view</span>
                <span className="max-w-[8rem] truncate text-xs text-muted">{currentView ? PREVIEW_LABELS[currentView] : "Myself"}</span>
              </M.Item>
            )}
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
                    {c.current ? <Check className="size-4 text-brand-fg" aria-hidden /> : <Building2 className="size-4 text-muted" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{c.name}</span>
                      <span className="block text-xs text-muted">{c.role}{c.current ? " · current" : ""}</span>
                    </span>
                  </M.Item>
                ))}
                <M.Separator className="my-1 h-px bg-line" />
              </>
            )}
            {/* Shown when the server already confirmed the platform role; /admin checks it again. */}
            {platformAdmin && (
              <M.Item asChild className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface">
                <Link href="/admin"><ShieldCheck className="size-4" aria-hidden /> Platform administration</Link>
              </M.Item>
            )}
            {canCreateCompany && (
              <M.Item asChild className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface">
                <Link href="/onboarding"><Plus className="size-4" aria-hidden /> Create a company</Link>
              </M.Item>
            )}
            {demo && (
              <>
                <M.Item
                  onSelect={() => window.dispatchEvent(new Event(OPEN_DEMO_WELCOME))}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface"
                >
                  <Info className="size-4" aria-hidden /> About this demo
                </M.Item>
                <M.CheckboxItem
                  checked={demo.presentation}
                  disabled={toggling}
                  onSelect={togglePresentation}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface data-[disabled]:opacity-60"
                >
                  <MonitorPlay className="size-4" aria-hidden />
                  <span className="flex-1">Presentation mode</span>
                  <M.ItemIndicator>
                    <Check className="size-4 text-brand-fg" aria-hidden />
                  </M.ItemIndicator>
                </M.CheckboxItem>
                <M.Separator className="my-1 h-px bg-line" />
              </>
            )}
            <M.Label className="px-3 pt-1 pb-1 text-xs font-semibold text-muted uppercase">Appearance</M.Label>
            <M.RadioGroup value={theme} onValueChange={(v) => applyTheme(parseTheme(v))} aria-label="Appearance">
              {THEME_OPTIONS.map((o) => (
                <M.RadioItem
                  key={o.value}
                  value={o.value}
                  onSelect={(e) => e.preventDefault()}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-ink outline-none hover:bg-surface focus:bg-surface"
                >
                  <span className="flex size-4 items-center justify-center">
                    <M.ItemIndicator>
                      <Check className="size-4 text-brand-fg" aria-hidden />
                    </M.ItemIndicator>
                  </span>
                  {o.label}
                </M.RadioItem>
              ))}
            </M.RadioGroup>
            <M.Separator className="my-1 h-px bg-line" />
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
      {demo && <ChangeViewDialog open={viewOpen} onOpenChange={setViewOpen} current={currentView} />}
    </>
  );
}

"use client";

import { Dialog as D } from "radix-ui";
import { Info, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { dismissDemoWelcome } from "@/app/(app)/demo-actions";

/** Opens the welcome again from anywhere (the profile menu's "About this demo"). */
export const OPEN_DEMO_WELCOME = "taviron:open-demo-welcome";

/**
 * The demo company's welcome (docs/DEMO_TENANTS.md §2): shown once per person
 * and demo company until dismissed, then available from the profile menu.
 * It replaces the persistent demo bar; nothing here changes data or access.
 */
export function DemoWelcome({ initiallyOpen, companyName }: { initiallyOpen: boolean; companyName: string | null }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [, startSave] = useTransition();
  const pending = useRef(initiallyOpen); // the first dismissal is remembered once
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_DEMO_WELCOME, show);
    return () => window.removeEventListener(OPEN_DEMO_WELCOME, show);
  }, []);
  const change = (next: boolean) => {
    setOpen(next);
    if (!next && pending.current) {
      pending.current = false;
      startSave(() => dismissDemoWelcome());
    }
  };
  return (
    <D.Root open={open} onOpenChange={change}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <D.Content
          aria-describedby="demo-welcome-body"
          onOpenAutoFocus={(e) => { e.preventDefault(); primary.current?.focus(); }}
          className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-card p-6 shadow-xl focus:outline-none sm:p-7"
        >
          <D.Close className="absolute top-3 right-3 rounded p-1 text-muted hover:bg-surface hover:text-ink" aria-label="Close">
            <X className="size-5" aria-hidden />
          </D.Close>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-muted ring-1 ring-line">
            <Info className="size-3.5" aria-hidden /> Demo company{companyName ? ` · ${companyName}` : ""}
          </span>
          <D.Title className="mt-3 text-xl font-bold text-ink">Welcome to the Taviron demo</D.Title>
          <div id="demo-welcome-body" className="mt-3 space-y-3 text-sm leading-relaxed text-ink">
            <p>
              You’re exploring Taviron with fictional sample data. The company, people, trucks, loads, messages, financial
              figures and other records are examples created to show how the platform works.
            </p>
            <p>
              Nothing here is a real customer operation or transaction, and nothing is sent outside Taviron. Explore freely.
            </p>
            <p className="text-muted">
              To see the demo as a dispatcher, driver, mechanic or office user, use <strong className="text-ink">Change view</strong> in
              your profile menu (top right).
            </p>
          </div>
          <div className="mt-6 flex justify-end">
            <D.Close asChild>
              <Button ref={primary} className="w-full sm:w-auto">Explore the demo</Button>
            </D.Close>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

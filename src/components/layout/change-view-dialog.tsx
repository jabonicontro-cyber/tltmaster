"use client";

import { Dialog as D } from "radix-ui";
import { Check, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/lib/cn";
import { PREVIEW_LABELS, PREVIEW_ROLES, type PreviewRole } from "@/lib/platform/preview";
import { setDemoPreview } from "@/app/(app)/demo-actions";

const HINTS: Record<PreviewRole | "self", string> = {
  self: "Your own access",
  owner: "Everything the company owner sees",
  dispatcher: "Orders, dispatch, tickets and fleet",
  multi: "Dispatch plus My Day as a driver",
  office: "Customers, quotes, billing and people",
  driver: "Only My Day, as a driver sees it",
  mechanic: "Fleet, maintenance and driver reports",
};

/**
 * "Change view" from the profile menu, in a demo company only: switches the
 * existing role preview (server action + cookie). A view only narrows the
 * person's real permissions; the server and database keep enforcing them.
 */
export function ChangeViewDialog({ open, onOpenChange, current }: { open: boolean; onOpenChange: (open: boolean) => void; current: PreviewRole | null }) {
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const choose = (role: PreviewRole | "self") =>
    start(async () => {
      const fd = new FormData();
      fd.set("role", role);
      fd.set("next", pathname);
      onOpenChange(false); // the action ends in a redirect; the header shows the new view
      await setDemoPreview(fd);
    });
  const options: Array<PreviewRole | "self"> = ["self", ...PREVIEW_ROLES];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-card shadow-xl focus:outline-none">
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <D.Title className="text-lg font-bold text-ink">Change view</D.Title>
              <D.Description className="mt-0.5 text-sm text-muted">
                See the demo as another role. A view only hides what that role cannot see; it never adds access.
              </D.Description>
            </div>
            <D.Close className="rounded p-1 text-muted hover:bg-surface hover:text-ink" aria-label="Close">
              <X className="size-5" aria-hidden />
            </D.Close>
          </div>
          <ul className="mt-3 space-y-1 overflow-y-auto px-3 pb-4" aria-label="Views" aria-busy={pending}>
            {options.map((o) => {
              const selected = (current ?? "self") === o;
              return (
                <li key={o}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    disabled={pending}
                    onClick={() => (selected ? onOpenChange(false) : choose(o))}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60",
                      selected ? "border-strong bg-surface" : "border-transparent hover:bg-surface",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-ink">{o === "self" ? "Myself" : PREVIEW_LABELS[o]}</span>
                      <span className="block text-xs text-muted">{HINTS[o]}</span>
                    </span>
                    {selected && <Check className="size-4 shrink-0 text-brand-fg" aria-hidden />}
                    {selected && <span className="sr-only">(current view)</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

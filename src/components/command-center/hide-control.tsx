"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EyeOff, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { hideException, unhideException } from "@/app/(app)/command-center/actions";

/** Hide a non-urgent item from your own view for a while (it stays open for everyone), or show it again. */
export function HideControl({ itemKey, hiddenUntil }: { itemKey: string; hiddenUntil: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setOpen(false);
    if (!r.ok) toast.error(r.error ?? "Could not save.");
    else { toast.success(r.message ?? "Saved"); router.refresh(); }
  };
  if (hiddenUntil) {
    return (
      <Button size="sm" variant="ghost" loading={busy} icon={<Eye className="size-4" />} onClick={() => run(() => unhideException({ key: itemKey }))}>
        Show again
      </Button>
    );
  }
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" icon={<EyeOff className="size-4" />} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Hide for me
      </Button>
      {open && (
        <div role="group" aria-label="Hide for how long" className="absolute right-0 z-10 mt-1 w-56 rounded-2xl border border-line/70 bg-card p-2 text-sm shadow-float">
          <p className="px-1 pb-1 text-xs text-muted">Only from your view. The problem stays open and counted.</p>
          {([[4, "For 4 hours"], [24, "For 1 day"], [72, "For 3 days"]] as const).map(([h, label]) => (
            <button key={h} type="button" disabled={busy} className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface" onClick={() => run(() => hideException({ key: itemKey, hours: h }))}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

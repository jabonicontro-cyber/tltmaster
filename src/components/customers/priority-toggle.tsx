"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Star } from "lucide-react";
import { setCustomerPriority } from "@/app/(app)/customers/actions";
import { cn } from "@/lib/cn";

/** Priority customer switch (owner 2026-11-02): their loads are planned first by Smart Dispatch and Plan the day. */
export function PriorityToggle({ customerId, priority, canEdit }: { customerId: string; priority: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const flip = () => start(async () => {
    const r = await setCustomerPriority(customerId, !priority);
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.message ?? "Saved.");
    router.refresh();
  });
  if (!canEdit) {
    return priority ? <span className="inline-flex h-[22px] items-center gap-1 rounded-full bg-amber-50 px-2 text-xs font-semibold text-amber-900"><Star className="size-3.5 fill-current" aria-hidden /><span className="pill-text">Priority customer</span></span> : null;
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={priority}
      aria-label="Priority customer"
      onClick={flip}
      disabled={busy}
      className={cn("inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition-colors disabled:opacity-60",
        priority ? "border-amber-300 bg-amber-50 text-amber-900" : "border-line bg-card text-muted hover:text-ink")}
      title="Priority customers' loads are planned first, right after urgent orders"
    >
      <Star className={cn("size-4", priority && "fill-current")} aria-hidden />
      <span className="pill-text">{priority ? "Priority customer" : "Make priority"}</span>
    </button>
  );
}

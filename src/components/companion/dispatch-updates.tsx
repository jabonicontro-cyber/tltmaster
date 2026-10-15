"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { markNotificationsRead } from "@/app/(app)/communications/actions";

/**
 * New or changed loads from dispatch, at the top of My Day until the driver taps "Got it". "Got it" only records that
 * the notice was dismissed on this account; it is not proof that the driver read or understood it, so dispatch still
 * confirms changes that matter by phone.
 */
export function DispatchUpdates({ items, timeZone }: { items: Array<{ id: string; title: string; created_at: string }>; timeZone: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (items.length === 0) return null;
  const when = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  const dismiss = (ids: string[]) => start(async () => {
    const r = await markNotificationsRead(ids);
    if (!r.ok) { toast.error(r.error ?? "Could not save. Try again."); return; }
    router.refresh();
  });
  return (
    <section aria-label="Updates from dispatch" className="space-y-2">
      <h2 className="text-lg font-bold">Updates from dispatch</h2>
      <ul className="space-y-2">
        {items.map((n) => (
          <li key={n.id} className="flex items-start gap-3 rounded-md bg-card px-4 py-3 text-sm ring-1 ring-line">
            <BellRing className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1"><strong className="block">{n.title}</strong><span className="text-muted">{when(n.created_at)}</span></span>
            <Button size="sm" variant="secondary" className="min-h-11" disabled={pending} onClick={() => dismiss([n.id])}>Got it</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

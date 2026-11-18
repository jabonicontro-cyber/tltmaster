"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { moveJobToPartArrival } from "@/app/(app)/maintenance/part-wait-actions";
import { moveLabel, partArrivalText, type PartArrivalConflict } from "@/lib/maintenance/part-arrival";
import { cn } from "@/lib/cn";

/**
 * "Scheduled Nov 18, but DEF level sensor is expected Nov 20." with "Move to Nov 20" for people who manage the shop
 * (WK3). A warning and an offer only: the job moves when the person presses the button, never on its own.
 */
export function PartArrivalWarning({ conflict, canMove, number, className }: { conflict: PartArrivalConflict; canMove: boolean; number?: string; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const label = moveLabel(conflict);
  const move = () => start(async () => {
    const r = await moveJobToPartArrival({ workOrderId: conflict.workOrderId, from: conflict.scheduledFor, to: conflict.moveTo! });
    if (!r.ok) { toast.error(r.error); router.refresh(); return; }
    toast.success(r.message ?? "Moved.");
    router.refresh();
  });
  return (
    <div className={cn("relative z-10 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm", className)} data-testid="part-arrival-warning">
      <p className="flex min-w-0 flex-1 items-start gap-1.5 text-amber-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
        <span>{number ? `${number}: ` : ""}{partArrivalText(conflict)}</span>
      </p>
      {canMove && label && (
        <Button size="sm" variant="secondary" loading={pending} onClick={move} icon={<CalendarClock className="size-4" aria-hidden />}>{label}</Button>
      )}
    </div>
  );
}

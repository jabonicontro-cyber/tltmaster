"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { approveLoadBuild } from "./actions";

/** The dispatcher's explicit approval: the server recomputes the draft and adds the loads only if it is unchanged. */
export function ApproveLoadBuild(props: { orderId: string; payload: number; perDay: number; mode: "even" | "earliest"; startTime?: string; endTime?: string; reviewed: string; count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { count, ...input } = props;
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <FormError message={error} />
      <Button
        loading={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await approveLoadBuild(input);
            if (!r.ok) return setError(r.error);
            toast.success(r.message ?? "Loads added.");
            router.push(`/orders/${props.orderId}`);
            router.refresh();
          })
        }
      >
        Approve and add {count} planned load{count === 1 ? "" : "s"}
      </Button>
      <p className="text-xs text-muted">No truck or driver is assigned. Loads can be changed or canceled on the dispatch board.</p>
    </div>
  );
}

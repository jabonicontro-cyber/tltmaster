"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { sendToQuickBooks } from "@/app/(app)/billing/accounting-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { InvoiceSend } from "@/server/data/accounting";

// Send handed-off orders to QuickBooks (master plan B82, B89): a person presses Send; nothing is sent on its own.
// An order split between businesses shows one status per business's invoice. In demo companies the send is simulated.

export function QuickBooksSendButton({ handoffOrderIds, label, variant = "secondary" }: { handoffOrderIds: string[]; label: string; variant?: "secondary" | "ghost" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!handoffOrderIds.length) return null;
  return (
    <Button size="sm" variant={variant} loading={pending} icon={<Send className="size-4" aria-hidden />}
      onClick={() => start(async () => {
        const r = await sendToQuickBooks({ handoffOrderIds });
        if (r.ok) toast.success(r.message ?? "Sent to QuickBooks."); else toast.error(r.error, { duration: 12_000 });
        router.refresh();
      })}>
      {label}
    </Button>
  );
}

/** One line per business invoice: sent (with its number), failed (with QuickBooks' reason) or being sent. */
export function QuickBooksStatus({ sends, entityNames }: { sends: InvoiceSend[]; entityNames: Record<string, string> }) {
  if (!sends.length) return null;
  const many = sends.length > 1;
  return (
    <div className="mt-1 space-y-0.5 text-sm">
      {sends.map((s) => {
        const who = many || s.billing_entity_id ? `${entityNames[s.billing_entity_id ?? ""] ?? "Business"}: ` : "";
        if (s.status === "sent") {
          const diff = s.qbo_total_cents !== null && s.taviron_total_cents !== null && s.qbo_total_cents !== s.taviron_total_cents;
          return (
            <div key={s.id} className="flex flex-wrap items-center gap-1.5">
              <Badge tone="green">{s.simulated ? "Simulated" : "In QuickBooks"}</Badge>
              <span className="text-muted">{who}invoice {s.external_number}{diff ? " · total differs, check the tax in QuickBooks" : ""}</span>
            </div>
          );
        }
        if (s.status === "sending") return <div key={s.id} className="flex items-center gap-1.5"><Badge tone="gray">Sending</Badge><span className="text-muted">{who}in progress</span></div>;
        return <div key={s.id} className="flex flex-wrap items-center gap-1.5"><Badge tone="amber">Not sent</Badge><span className="text-muted">{who}{s.last_error || "The send failed."}</span></div>;
      })}
    </div>
  );
}

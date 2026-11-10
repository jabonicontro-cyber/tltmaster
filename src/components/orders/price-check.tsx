"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { confirmOrderPrice } from "@/app/(app)/orders/actions";
import { centsToInput, parseMoneyToCents } from "@/lib/money";
import { priceCorrections, type CorrectableLine } from "@/lib/orders/price-check";

export interface PriceCheckView {
  orderId: string;
  orderNumber: string;
  /** Who typed the price, and when (already formatted). */
  typedBy: string;
  typedAt: string;
  /** The typed lines, e.g. "Line 2, Rush hauling: $95.00 per load". */
  lines: string[];
  /** The typed per-unit lines billing may correct while confirming (20261120016400). */
  correctable: CorrectableLine[];
}

/**
 * "Price to be checked" (financial review M1, owner 2026-11-10): a price typed on a line without a price-list rate by
 * someone who cannot set prices. The order is not handed off or invoiced until someone with pricing or billing rights
 * confirms it; that is the one action here. Everyone else sees who decides.
 */
export function PriceCheckNotice({ check, canConfirm, canCorrect }: { check: PriceCheckView; canConfirm: boolean; canCorrect: boolean }) {
  return (
    <Notice tone="warning" title="Price to be checked">
      <p>
        {check.typedBy} typed {check.lines.length === 1 ? "a price" : "prices"} without a price-list rate on {check.typedAt}. The order can be
        dispatched and delivered; it is not billed until {canConfirm ? "you confirm" : "someone who sets prices or manages billing confirms"} the price.
      </p>
      {check.lines.length > 0 && (
        <ul className="mt-1 list-disc pl-5" aria-label="Typed prices">
          {check.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      {canConfirm && <div className="mt-2"><ConfirmPriceButton orderId={check.orderId} orderNumber={check.orderNumber} lines={canCorrect ? check.correctable : []} /></div>}
    </Notice>
  );
}

/**
 * The one action on a typed price: confirm it (recorded in the order's history). Billing (billing.manage) may correct
 * each typed price in the same step, with a reason (owner 2026-11-10): `lines` lists what they may correct, empty for
 * everyone else.
 */
export function ConfirmPriceButton({ orderId, orderNumber, lines = [] }: { orderId: string; orderNumber: string; lines?: CorrectableLine[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const initial = () => Object.fromEntries(lines.map((l) => [l.id, centsToInput(l.rateCents)]));
  const [prices, setPrices] = useState<Record<string, string>>(initial);
  const changes = priceCorrections(lines, prices, parseMoneyToCents);
  const correcting = changes === null || changes.length > 0;
  return (
    <>
      <Button size="sm" onClick={() => { setPrices(initial()); setOpen(true); }}>Confirm price</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Confirm the price on ${orderNumber}?`}
        description={lines.length
          ? "Keep the typed price, or enter the right one. The price becomes the order's price for billing; a change is recorded in the order's history with your reason."
          : "The typed price becomes the order's price for billing. This is recorded in the order's history."}
        confirmLabel={correcting ? "Correct and confirm" : "Confirm price"}
        onConfirm={async () => {
          if (changes === null) return "Enter each price in dollars, for example 95 or 12.50.";
          if (changes.length && note.trim().length < 3) return "Say why the price is corrected.";
          const r = await confirmOrderPrice(orderId, note, changes);
          if (!r.ok) return r.error ?? "Not confirmed.";
          toast.success(r.message ?? "Price confirmed.");
          setNote("");
          router.refresh();
        }}
      >
        <div className="space-y-3">
          {lines.map((l) => (
            <Field key={l.id} label={`${l.label}: price per ${l.unit} ($)`} htmlFor={`price-fix-${l.id}`}>
              <Input id={`price-fix-${l.id}`} inputMode="decimal" className="max-w-40 text-right tabular" value={prices[l.id] ?? ""}
                onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))} />
            </Field>
          ))}
          <Field
            label={correcting ? "Why is the price corrected?" : "Note (optional)"}
            htmlFor="price-check-note"
            required={correcting}
            hint={correcting ? "Recorded with the old and new price." : "For example who agreed the price with the customer."}
          >
            <Input id="price-check-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </ConfirmDialog>
    </>
  );
}

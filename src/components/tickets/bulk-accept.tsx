"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { acceptCleanTickets, type BulkAcceptResult } from "@/app/(app)/tickets/actions";

export interface CleanTicket {
  id: string;
  number: string;
  summary: string;
}

/**
 * Accept received tickets that nothing flagged, after the reviewer has checked
 * them against the paper. Everything is listed and confirmed first; each ticket
 * is re-checked and accepted on its own by the server.
 */
export function BulkAccept({ tickets }: { tickets: CleanTicket[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [results, setResults] = useState<BulkAcceptResult[] | null>(null);
  if (tickets.length === 0) return null;

  return (
    <>
      <Button variant="secondary" icon={<CheckCheck className="size-4" />} onClick={() => { setChosen(tickets.map((t) => t.id)); setResults(null); setOpen(true); }}>
        Accept clean tickets ({tickets.length})
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Accept tickets without review flags"
        description="Only tickets that were received with no review reason are listed. Accepting confirms each matches its paper ticket; it does not bill anyone or change any order."
        confirmLabel={`Accept ${chosen.length} ticket${chosen.length === 1 ? "" : "s"}`}
        onConfirm={async () => {
          if (chosen.length === 0) return "Choose at least one ticket.";
          const r = await acceptCleanTickets({ ticketIds: chosen });
          if (!r.ok) return r.error;
          setResults(r.data.results);
          toast.success(r.message ?? "Done");
          router.refresh();
          // Keep the dialog open when something was not accepted, so the reasons are visible.
          if (r.data.results.some((x) => x.outcome !== "accepted")) return `${r.message} Close this when you have read the list.`;
        }}
      >
        <fieldset className="max-h-72 space-y-1 overflow-y-auto" aria-label="Tickets to accept">
          {tickets.map((t) => {
            const res = results?.find((x) => x.ticketId === t.id);
            return (
              <label key={t.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-brand"
                  checked={chosen.includes(t.id)}
                  disabled={Boolean(res)}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))}
                />
                <span>
                  <strong className="tabular">{t.number}</strong> {t.summary}
                  {res && <span className={res.outcome === "accepted" ? " text-green-800" : " text-brand"}> — {res.message}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      </ConfirmDialog>
    </>
  );
}

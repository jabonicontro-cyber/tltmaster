"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { resolveTicketMistake } from "@/app/(app)/tickets/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";

/** "Mark handled" on a driver's mistake report (TM1): what was done, in a few words; tickets.review. */
export function MistakeResolve({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>Mark handled</Button>;
  return (
    <form
      className="flex w-full flex-wrap items-start gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await resolveTicketMistake({ reportId, note });
        setBusy(false);
        if (!r.ok) return setError(r.error);
        toast.success(r.message ?? "Marked as handled.");
        router.refresh();
      }}
    >
      <label htmlFor={`resolve-${reportId}`} className="sr-only">What did you do?</label>
      <Input id={`resolve-${reportId}`} value={note} onChange={(e) => { setNote(e.target.value); setError(null); }} placeholder="e.g. The ticket was right" maxLength={500} className="min-w-0 flex-1" />
      <Button type="submit" size="sm" disabled={busy}>Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      {error && <p role="alert" className="w-full text-sm text-critical">{error}</p>}
    </form>
  );
}

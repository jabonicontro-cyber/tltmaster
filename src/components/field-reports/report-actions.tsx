"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCheck, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { reviewFieldReport } from "@/app/(app)/field-reports/actions";

export function ReportActions({ reportId, status }: { reportId: string; status: "open" | "acknowledged" | "resolved" }) {
  const router = useRouter();
  const [action, setAction] = useState<"acknowledge" | "resolve" | null>(null);
  const [note, setNote] = useState("");
  if (status === "resolved") return null;
  return (
    <div className="flex flex-wrap gap-2">
      {status === "open" && <Button variant="secondary" icon={<Eye className="size-4" />} onClick={() => { setNote(""); setAction("acknowledge"); }}>Acknowledge</Button>}
      <Button icon={<CheckCheck className="size-4" />} onClick={() => { setNote(""); setAction("resolve"); }}>Resolve</Button>
      <ConfirmDialog
        open={Boolean(action)}
        onOpenChange={(o) => !o && setAction(null)}
        title={action === "acknowledge" ? "Acknowledge the report" : "Resolve the report"}
        description={action === "acknowledge"
          ? "Tells the driver the office has seen it. It stays open until resolved."
          : "Closes the report. Change the truck's service status or reassign loads in Fleet or Dispatch — resolving does not do that."}
        confirmLabel={action === "acknowledge" ? "Acknowledge" : "Resolve"}
        onConfirm={async () => {
          if (!action) return;
          if (action === "resolve" && !note.trim()) return "Enter how it was resolved.";
          const r = await reviewFieldReport({ reportId, action, note });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      >
        <Field label={action === "resolve" ? "How was it resolved?" : "Note (optional)"} htmlFor="report-note" required={action === "resolve"}>
          <Textarea id="report-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

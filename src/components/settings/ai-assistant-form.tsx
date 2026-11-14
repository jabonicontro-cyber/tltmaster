"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setAiAssistantAllowed } from "@/app/(app)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";

/**
 * Ask Taviron for the whole company (master plan §11a): off until someone who manages settings turns it on. On only
 * allows it; the AI switches, limits and evaluations still decide whether it can answer, and each person reads a short
 * notice before their first question.
 */
export function AiAssistantForm({ allowed, changedAt, canEdit, timeZone }: { allowed: boolean; changedAt: string | null; canEdit: boolean; timeZone?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const when = changedAt ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(new Date(changedAt)) : null;

  async function change(): Promise<string | void> {
    const r = await setAiAssistantAllowed(!allowed);
    if (!r.ok) return r.error;
    toast.success(r.message ?? "Saved.");
    router.refresh();
  }

  return (
    <section id="ask-taviron" className="space-y-4 p-5 sm:p-6" aria-label="Ask Taviron">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-ink">Ask Taviron</h2>
        <Badge tone={allowed ? "green" : "gray"}>{allowed ? "On" : "Off"}</Badge>
      </div>
      <div className="max-w-2xl space-y-2 text-sm text-muted">
        <p>
          An assistant that answers questions about your orders, the attention queue, maintenance and the week ahead, from the records each person may see. It only reads; it never assigns, sends, bills or changes anything.
        </p>
        <p>
          Questions go to OpenAI, Taviron&apos;s AI provider, with names and order numbers replaced by codes. Taviron keeps usage counts only, never the questions or answers. Each person sees a short notice before their first question.{" "}
          <a href="/privacy#ai" target="_blank" rel="noopener" className="font-semibold text-brand-fg hover:underline">How your data is handled</a>
        </p>
        {when && <p className="text-xs">Last changed {when}. The audit log shows who changed it.</p>}
      </div>
      {canEdit ? (
        <Button variant={allowed ? "secondary" : "primary"} onClick={() => setOpen(true)}>{allowed ? "Turn off Ask Taviron" : "Turn on Ask Taviron"}</Button>
      ) : (
        <p className="text-sm text-muted">An owner of your company can change this.</p>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={allowed ? "Turn off Ask Taviron?" : "Turn on Ask Taviron for your company?"}
        description={allowed
          ? "Nobody in your company can ask questions any more, and nothing more is sent to the AI provider. You can turn it on again later."
          : "People in your company who see orders, dispatch, maintenance, tickets or billing can ask it questions. Their questions go to OpenAI with names replaced by codes. Answers are marked as AI-generated and can be wrong."}
        confirmLabel={allowed ? "Turn off" : "Turn on"}
        onConfirm={change}
      />
    </section>
  );
}

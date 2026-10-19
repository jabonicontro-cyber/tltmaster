"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Select, Textarea } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import type { StatusAction } from "@/lib/onboarding/tasks";
import { assignOnboardingTask, commentOnOnboarding, setOnboardingStatus } from "@/app/(app)/setup/actions";
import {
  generateOnboarding, remindOnboardingTask, staffAssignOnboardingTask, staffCommentOnOnboarding, staffSetOnboardingStatus,
} from "@/app/admin/onboarding/checklist-actions";

export type ChecklistSide = "customer" | "staff";

function useRefreshing<T>(action: (fd: FormData) => Promise<ActionResult<T>>, after?: () => void) {
  const router = useRouter();
  return useFormAction(action, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      after?.();
      router.refresh();
    },
  });
}

/** Status buttons; a change that needs a reason opens a short reason field first. */
export function TaskStatusActions({ side, taskId, companyId, actions }: { side: ChecklistSide; taskId: string; companyId?: string; actions: StatusAction[] }) {
  const [asking, setAsking] = useState<StatusAction | null>(null);
  const form = useRef<HTMLFormElement>(null);
  // The shared form hook reads the form's fields, not the clicked button: each button sets this field first.
  const status = useRef<HTMLInputElement>(null);
  const { pending, onSubmit, formError } = useRefreshing(side === "staff" ? staffSetOnboardingStatus : setOnboardingStatus, () => setAsking(null));
  if (actions.length === 0) return null;
  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-2" aria-label="Change status">
      <FormError message={formError} />
      <input type="hidden" name="task" value={taskId} />
      {companyId ? <input type="hidden" name="company" value={companyId} /> : null}
      <input ref={status} type="hidden" name="status" defaultValue={asking?.status ?? ""} key={asking?.status ?? "none"} />
      {asking ? (
        <>
          <Field label={`Reason for “${asking.label}”`} htmlFor={`note-${taskId}`} required>
            <Textarea id={`note-${taskId}`} name="note" rows={2} maxLength={1000} required minLength={3} autoFocus />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={pending}>{asking.label}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) =>
            a.needsNote ? (
              <Button key={a.status + a.label} type="button" size="sm" variant="secondary" onClick={() => setAsking(a)}>{a.label}</Button>
            ) : (
              <Button key={a.status + a.label} type="submit" size="sm" variant={a.primary ? "primary" : "secondary"} loading={pending}
                onClick={() => { if (status.current) status.current.value = a.status; }}>
                {a.label}
              </Button>
            ),
          )}
        </div>
      )}
    </form>
  );
}

export function TaskCommentForm({ side, taskId, companyId }: { side: ChecklistSide; taskId: string; companyId?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const { pending, onSubmit, formError, fieldError } = useRefreshing(side === "staff" ? staffCommentOnOnboarding : commentOnOnboarding, () => form.current?.reset());
  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-2" aria-label="Add a message">
      <FormError message={formError} />
      <input type="hidden" name="task" value={taskId} />
      {companyId ? <input type="hidden" name="company" value={companyId} /> : null}
      <Field label="Message" htmlFor={`body-${taskId}`} error={fieldError("body")}>
        <Textarea id={`body-${taskId}`} name="body" rows={2} maxLength={2000} required />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="secondary" loading={pending}>{side === "staff" ? "Add" : "Send to Taviron"}</Button>
        {side === "staff" ? (
          <label className="inline-flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="internal" className="size-4 rounded border-line accent-brand" /> Internal note (Taviron only)
          </label>
        ) : null}
      </div>
    </form>
  );
}

export function TaskAssignForm({ side, taskId, companyId, people, assignee, dueOn }: {
  side: ChecklistSide; taskId: string; companyId?: string; people: Array<{ id: string; name: string }>; assignee: string | null; dueOn: string | null;
}) {
  const { pending, onSubmit, formError } = useRefreshing(side === "staff" ? staffAssignOnboardingTask : assignOnboardingTask);
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end" aria-label="Owner and due date">
      <FormError message={formError} />
      <input type="hidden" name="task" value={taskId} />
      {companyId ? <input type="hidden" name="company" value={companyId} /> : null}
      {side === "customer" ? (
        <Field label="Owner" htmlFor={`assignee-${taskId}`}>
          <Select id={`assignee-${taskId}`} name="assignee" defaultValue={assignee ?? ""}>
            <option value="">Nobody yet</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      ) : (
        // Taviron sets the due date only; the company chooses its own owner (kept as is).
        <input type="hidden" name="assignee" value={assignee ?? ""} />
      )}
      <Field label="Due" htmlFor={`due-${taskId}`}>
        <DateInput id={`due-${taskId}`} name="due_on" defaultValue={dueOn ?? ""} />
      </Field>
      <Button type="submit" size="sm" variant="secondary" loading={pending}>Save</Button>
    </form>
  );
}

/** Upload a document (PDF, JPEG, PNG or CSV, up to 10 MB) to a task through the checked upload route. */
export function TaskDocumentUpload({ side, taskId }: { side: ChecklistSide; taskId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("task", taskId);
      fd.set("side", side === "staff" ? "platform" : "company");
      fd.set("upload_key", crypto.randomUUID());
      const res = await fetch("/onboarding/documents", { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "The file could not be added. Try again.");
        return;
      }
      toast.success(`${file.name} added.`);
      router.refresh();
    } catch {
      setError("The server could not be reached. Try again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="space-y-1">
      <label htmlFor={`file-${taskId}`} className="text-sm font-semibold text-ink">Add a file</label>
      <input
        ref={input}
        id={`file-${taskId}`}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.csv,application/pdf,image/jpeg,image/png,text/csv"
        disabled={busy}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) void upload(f);
        }}
        className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-ink"
      />
      <p className="text-xs text-muted">{busy ? "Uploading…" : "PDF, JPEG, PNG or CSV (UTF-8), up to 10 MB. Only your company and Taviron can open it."}</p>
      {error ? <p role="alert" className="text-sm text-critical">{error}</p> : null}
    </div>
  );
}

export function RemindButton({ taskId, companyId }: { taskId: string; companyId: string }) {
  const { pending, onSubmit, formError } = useRefreshing(remindOnboardingTask);
  return (
    <form onSubmit={onSubmit} aria-label="Remind">
      <FormError message={formError} />
      <input type="hidden" name="task" value={taskId} />
      <input type="hidden" name="company" value={companyId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>Send in-app reminder</Button>
    </form>
  );
}

export function GenerateChecklistButton({ companyId, hasTasks }: { companyId: string; hasTasks: boolean }) {
  const { pending, onSubmit, formError } = useRefreshing(generateOnboarding);
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <FormError message={formError} />
      <input type="hidden" name="company" value={companyId} />
      <Button type="submit" size="sm" variant={hasTasks ? "secondary" : "primary"} loading={pending}>
        {hasTasks ? "Update Checklist" : "Start Onboarding"}
      </Button>
    </form>
  );
}

"use client";

import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { Field, Input } from "@/components/ui/form";
import type { useUsername } from "./use-username";

/** Username input with its availability line and a "Suggest one" button (automatic from the name). */
export function UsernameField({ u, id, error }: { u: ReturnType<typeof useUsername>; id: string; error?: string }) {
  const { normalized, availability } = u;
  return (
    <>
      <Field label="Username" htmlFor={id} required error={error}
        hint={u.automatic ? "Filled in from the name and checked to be free. Type your own if you prefer." : "What they type to sign in. Lowercase letters, digits, dots or hyphens (3–32)."}>
        <div className="flex gap-2">
          <Input id={id} value={u.username} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={`${id}-status`}
            onChange={(e) => u.type(e.target.value)} />
          <button type="button" onClick={u.suggestAgain}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
            <RefreshCw className={`size-4 ${u.suggesting ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden /> Suggest one
          </button>
        </div>
      </Field>
      <p id={`${id}-status`} role="status" className="self-end pb-2 text-sm">
        {!normalized ? null : u.suggesting || availability.checking ? <span className="text-muted">Checking…</span>
          : availability.valid === false ? <span className="text-critical">Not a valid username.</span>
          : availability.available === true ? <span className="inline-flex items-center gap-1 text-ink"><CheckCircle2 className="size-4 text-brand-fg" aria-hidden /> {normalized} is available</span>
          : availability.available === false ? <span className="inline-flex items-center gap-1 text-critical"><CircleAlert className="size-4" aria-hidden /> {normalized} is taken</span> : null}
      </p>
    </>
  );
}

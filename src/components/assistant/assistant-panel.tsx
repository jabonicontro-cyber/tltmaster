"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { askAssistant, type AssistantView } from "@/app/(app)/assistant/actions";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/form";

const KIND_NOTE: Record<AssistantView["kind"], string | null> = {
  answer: null,
  clarify: "Ask Taviron needs one more detail.",
  no_data: "This information is not in Taviron, or not available to you.",
};

/**
 * Ask Taviron (docs/AI.md §12): one question at a time, answered on the server from the person's own company records.
 * The answer is labelled as AI-generated, lists the records it used as links, and never changes anything.
 */
export function AssistantPanel({ examples }: { examples: string[] }) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<AssistantView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (text.length < 3 || busy) return;
    setQuestion(text);
    setBusy(true);
    setError(null);
    setView(null);
    setAsked(text);
    const r = await askAssistant({ question: text });
    setBusy(false);
    if (r.ok) setView(r.data);
    else setError(r.error);
  }

  return (
    <div className="space-y-5">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <Field label="Your question" htmlFor="assistant-question" hint="About your company's orders, loads, maintenance, the week ahead, or how a page works. Read only.">
          <Textarea
            id="assistant-question"
            rows={3}
            maxLength={500}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(question);
              }
            }}
            placeholder="e.g. Which loads still need a truck?"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={busy} disabled={busy || question.trim().length < 3} icon={<Sparkles className="size-4" aria-hidden />}>Ask</Button>
          <span className="text-xs text-muted">Enter to ask · Shift+Enter for a new line</span>
        </div>
      </form>

      <div className="flex flex-wrap gap-2" aria-label="Example questions">
        {examples.map((x) => (
          <button key={x} type="button" disabled={busy} onClick={() => void ask(x)}
            className="min-h-9 rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink hover:bg-surface disabled:opacity-50">
            {x}
          </button>
        ))}
      </div>

      <div aria-live="polite" className="space-y-3">
        {busy && <p className="text-sm text-muted">Reading your records and asking the model…</p>}
        {error && (
          <div role="alert" className="rounded-lg border border-line bg-card p-4 text-sm text-ink">
            <p className="font-semibold">{error}</p>
            <p className="mt-1 text-muted">Nothing was changed. The Command Center, Dispatch and Maintenance pages show the same records directly.</p>
            {asked && <Button className="mt-3" size="sm" variant="secondary" onClick={() => void ask(asked)}>Try again</Button>}
          </div>
        )}
        {view && (
          <article className="rounded-lg border border-line bg-card p-4" aria-labelledby="assistant-answer-title">
            <h2 id="assistant-answer-title" className="text-sm font-semibold text-muted">Answer to “{asked}”</h2>
            {KIND_NOTE[view.kind] && <p className="mt-2 text-sm font-semibold text-ink">{KIND_NOTE[view.kind]}</p>}
            <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-ink">{view.answer}</p>
            {view.sources.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Records used</h3>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {view.sources.map((s) => (
                    <li key={`${s.label}-${s.href}`}>
                      {s.href ? (
                        <Link href={s.href} className="inline-flex min-h-9 items-center gap-1 rounded-md border border-line px-2.5 py-1 text-sm font-semibold text-brand-fg hover:bg-surface">
                          {s.label} <ArrowUpRight className="size-3.5" aria-hidden />
                        </Link>
                      ) : (
                        <span className="inline-flex min-h-9 items-center rounded-md border border-line px-2.5 py-1 text-sm text-ink">{s.label}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {view.followUps.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2" aria-label="Follow-up questions">
                {view.followUps.map((f) => (
                  <button key={f} type="button" onClick={() => void ask(f)} className="min-h-9 rounded-full border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface">{f}</button>
                ))}
              </div>
            )}
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              AI-generated from your company&apos;s records · checked against them before it is shown · it changes nothing.
              {" "}Model {view.model}
              {view.tokens.input !== null && view.tokens.output !== null && <> · {view.tokens.input + view.tokens.output} tokens</>}
              {view.estimatedCostUsd !== null && <> · estimated cost ${view.estimatedCostUsd.toFixed(4)}</>}
            </p>
          </article>
        )}
      </div>
    </div>
  );
}

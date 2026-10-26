"use client";

import { PhoneInput } from "@/components/ui/phone-input";
import { useRef, useState, type FormEvent } from "react";
import { CheckCircle2 } from "lucide-react";

type Kind = "demo" | "contact";

const input =
  "mt-1.5 block w-full rounded-xl border border-[#0c1a2b]/15 bg-white px-3 py-2.5 text-base text-cloud placeholder:text-silver/60 focus:border-electric focus:ring-2 focus:ring-electric/35 focus:outline-none aria-[invalid=true]:border-red-600";

/**
 * Demo request / contact form. Posts JSON to /api/leads; without JavaScript
 * the same form posts normally and the server redirects back with the result.
 */
export function LeadForm({ kind, initialError, sent, initialMessage }: { kind: Kind; initialError?: string; sent?: boolean; /** Prefilled message (the page the visitor came from). */ initialMessage?: string }) {
  const startedAt = useRef<number | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(Boolean(sent));
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const begin = () => {
    startedAt.current ??= Date.now();
  };

  /**
   * Inline validation (Apple: validate as you go, not only on submit): when a field is left, its own rules are checked
   * and a plain message appears under it; correcting the field clears the message as you type. Server checks still run.
   */
  const fieldMessage = (el: HTMLInputElement | HTMLTextAreaElement): string => {
    const v = el.validity;
    if (v.valid) return "";
    if (v.valueMissing) return "This is needed.";
    if (v.typeMismatch && el.type === "email") return "Enter an email address like name@company.com.";
    if (v.rangeUnderflow || v.rangeOverflow || v.badInput || v.stepMismatch) return "Enter a whole number in range.";
    if (v.tooLong) return "This is too long.";
    return "Check this field.";
  };
  const onFieldBlur = (e: React.FocusEvent<HTMLFormElement>) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !el.name || el.type === "hidden") return;
    const message = fieldMessage(el);
    setFields((f) => (message ? { ...f, [el.name]: message } : Object.fromEntries(Object.entries(f).filter(([k]) => k !== el.name))));
  };
  const onFieldInput = (e: React.FormEvent<HTMLFormElement>) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !fields[el.name]) return;
    if (!fieldMessage(el)) setFields((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== el.name)));
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setFields({});
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...data, elapsed_ms: startedAt.current ? Date.now() - startedAt.current : 0 }),
      });
      const body = (await res.json().catch(() => null)) as { ok: boolean; error?: string; fieldErrors?: Record<string, string> } | null;
      if (body?.ok) {
        setDone(true);
      } else {
        setError(body?.error ?? "Your message could not be sent. Please try again.");
        setFields(body?.fieldErrors ?? {});
      }
    } catch {
      setError("Your message could not be sent. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="rounded-[1.75rem] border border-[#0c1a2b]/[0.06] bg-navy-2 p-8 shadow-card">
        <CheckCircle2 className="size-8 text-brand" aria-hidden />
        <h2 className="mt-4 text-xl font-bold text-cloud">Thank you — your message reached the Taviron team.</h2>
        <p className="mt-2 text-silver">{kind === "demo" ? "We will follow up by email to arrange the walkthrough." : "We will reply by email."}</p>
      </div>
    );
  }

  const err = (name: string) =>
    fields[name] ? (
      <p id={`${name}-error`} className="mt-1 text-sm text-red-600">
        {fields[name]}
      </p>
    ) : null;
  const aria = (name: string) => ({ "aria-invalid": Boolean(fields[name]) || undefined, "aria-describedby": fields[name] ? `${name}-error` : undefined });

  return (
    <form action="/api/leads" method="post" onSubmit={onSubmit} onFocus={begin} onBlur={onFieldBlur} onInput={onFieldInput} className="space-y-5 rounded-[1.75rem] border border-[#0c1a2b]/[0.06] bg-navy-2 p-6 shadow-card sm:p-8" noValidate>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="source_path" value={kind === "demo" ? "/demo" : "/contact"} />
      {/* Left empty by people; filled in by form-filling bots. */}
      <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden>
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {error ? (
        <p role="alert" className="rounded-xl border border-red-600/30 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block text-sm font-medium text-cloud">
          Full name
          <input name="name" required maxLength={120} autoComplete="name" className={input} {...aria("name")} />
          {err("name")}
        </label>
        <label className="block text-sm font-medium text-cloud">
          Work email
          <input name="email" type="email" required maxLength={254} autoComplete="email" className={input} {...aria("email")} />
          {err("email")}
        </label>
        <label className="block text-sm font-medium text-cloud">
          Company{kind === "contact" ? <span className="text-silver"> (optional)</span> : null}
          <input name="company_name" required={kind === "demo"} maxLength={160} autoComplete="organization" className={input} {...aria("company_name")} />
          {err("company_name")}
        </label>
        <label className="block text-sm font-medium text-cloud">
          Phone <span className="text-silver">(optional)</span>
          <PhoneInput bare name="phone" maxLength={40} className={input} {...aria("phone")} />
          {err("phone")}
        </label>
        {kind === "demo" ? (
          <>
            <label className="block text-sm font-medium text-cloud">
              Number of hauling trucks
              <input name="truck_count" type="number" inputMode="numeric" required min={0} max={100000} step={1} className={input} {...aria("truck_count")} />
              {err("truck_count")}
            </label>
            <label className="block text-sm font-medium text-cloud">
              Number of dispatch bases
              <input name="base_count" type="number" inputMode="numeric" required min={1} max={1000} step={1} className={input} {...aria("base_count")} />
              {err("base_count")}
              <span className="mt-1 block text-xs text-silver">Locations your trucks are dispatched from.</span>
            </label>
          </>
        ) : null}
      </div>
      <label className="block text-sm font-medium text-cloud">
        {kind === "demo" ? (
          <>
            What would you most like Taviron to improve? <span className="text-silver">(optional)</span>
          </>
        ) : (
          "Message"
        )}
        <textarea name="message" rows={5} maxLength={4000} required={kind === "contact"} defaultValue={initialMessage} className={input} {...aria("message")} />
        {err("message")}
      </label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-silver">
          We use these details only to reply to you. See the{" "}
          <a href="/privacy" className="underline hover:text-cloud">
            privacy notice
          </a>
          .
        </p>
        <button type="submit" disabled={pending} className="site-press rounded-full bg-action px-6 py-3 text-sm font-semibold text-white hover:bg-action-hover disabled:opacity-60">
          {pending ? "Sending…" : kind === "demo" ? "Request a demo" : "Send message"}
        </button>
      </div>
    </form>
  );
}

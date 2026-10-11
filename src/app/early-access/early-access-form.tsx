"use client";

import { useState } from "react";
import { ArrowRight, CircleAlert, Eye, EyeOff, Loader2 } from "lucide-react";
import { useFormAction } from "@/components/ui/use-form-action";
import { enterEarlyAccess } from "./actions";

export function EarlyAccessForm({ next }: { next?: string }) {
  const { pending, onSubmit, formError, fieldError } = useFormAction(enterEarlyAccess);
  const [visible, setVisible] = useState(false);
  const error = fieldError("password") ?? formError;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <input type="hidden" name="next" value={next ?? ""} />
      <div>
        <label htmlFor="password" className="block text-sm font-semibold text-cloud">
          Early Access password
        </label>
        <div className="relative mt-2">
          <input
            id="password"
            name="password"
            type={visible ? "text" : "password"}
            required
            autoFocus
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={128}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "password-error" : undefined}
            className="h-12 w-full rounded-lg border border-silver/25 bg-navy px-4 pr-12 text-base text-cloud placeholder:text-silver/50 focus:border-electric focus:ring-2 focus:ring-electric/30 focus:outline-none aria-[invalid]:border-amber-300"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-controls="password"
            aria-pressed={visible}
            aria-label="Show password"
            title={visible ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-silver hover:text-cloud"
          >
            {visible ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
          </button>
        </div>
        {error ? (
          <p id="password-error" role="alert" className="mt-2 flex gap-2 text-sm text-cloud">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="site-press inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-action px-5 text-base font-semibold text-white hover:bg-action-hover disabled:cursor-wait disabled:opacity-80"
      >
        {pending ? (
          <>
            <Loader2 className="size-5 animate-spin" aria-hidden /> Checking…
          </>
        ) : (
          <>
            Continue <ArrowRight className="size-5" aria-hidden />
          </>
        )}
      </button>
    </form>
  );
}

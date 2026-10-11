"use client";

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { enterEarlyAccess } from "./actions";

export function EarlyAccessForm({ next }: { next?: string }) {
  const { pending, onSubmit, result, fieldError } = useFormAction(enterEarlyAccess);
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <p className="inline-flex items-center gap-1.5 rounded-full bg-brand-light px-2.5 py-0.5 text-xs font-bold tracking-wide text-brand-fg uppercase">
          <KeyRound className="size-3.5" aria-hidden /> By invitation
        </p>
        <h1 className="text-2xl font-black text-ink">Early Access</h1>
        <p className="text-sm text-muted">
          Taviron is open to approved early-access participants. Enter the access code you received to continue to sign-in.
        </p>
      </div>
      {result && !result.ok && <FormError message={result.error} />}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Access code" htmlFor="code" error={fieldError("code")}>
        <Input
          id="code"
          name="code"
          required
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          className="font-mono tracking-wider uppercase"
          aria-describedby="code-help"
        />
      </Field>
      <p id="code-help" className="-mt-2 text-xs text-muted">Letters and numbers; dashes and spaces are optional.</p>
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? "Checking…" : "Continue"}
      </Button>
      <div className="space-y-1 border-t border-line pt-3 text-center text-sm text-muted">
        <p>Invited by your company? Open the link in your invitation email — it works without a code.</p>
        <p>
          Already admitted on this device? <Link href="/login" className="font-semibold text-ink hover:underline">Sign in</Link>
        </p>
      </div>
    </form>
  );
}

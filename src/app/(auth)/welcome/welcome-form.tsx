"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/password-input";
import { useFormAction } from "@/components/ui/use-form-action";
import { PASSWORD_RULES } from "@/lib/accounts";
import { completeFirstSignIn } from "./actions";

export function FirstSignInForm() {
  const router = useRouter();
  const [done, setDone] = useState<string | null>(null);
  const { pending, onSubmit, formError, fieldError } = useFormAction(completeFirstSignIn, {
    onSuccess: (r) => {
      setDone(r.data.next);
      router.replace(r.data.next);
    },
  });
  if (done) {
    return (
      <div role="status" className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3 text-sm text-ink">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand-fg" aria-hidden />
        <span>Your password is set. Taking you to your work…</span>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormError message={formError} />
      <div className="rounded-xl bg-surface p-3 text-sm text-ink">
        <p className="font-semibold">Your password needs:</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {PASSWORD_RULES.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </div>
      <Field label="New password" htmlFor="password" error={fieldError("password")}>
        <PasswordInput id="password" name="password" autoComplete="new-password" minLength={10} maxLength={72} required autoFocus className="h-12 text-base" />
      </Field>
      <Field label="Type it again" htmlFor="confirm" error={fieldError("confirm")}>
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" minLength={10} maxLength={72} required className="h-12 text-base" />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? "Saving…" : "Save My Password"}
      </Button>
    </form>
  );
}

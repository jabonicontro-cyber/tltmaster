"use client";

import Link from "next/link";
import { useRef, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { signUpWithAccessCode } from "./actions";

export function SignupForm() {
  // One key per form, made in the browser on the first submit (this page is
  // prerendered, so a key made while rendering would be shared by every visitor).
  // A double submit or retry reuses it and is recognised by the server.
  const requestKey = useRef<string | null>(null);
  const { pending, onSubmit: send, result, fieldError } = useFormAction(signUpWithAccessCode);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    requestKey.current ??= crypto.randomUUID();
    (event.currentTarget.elements.namedItem("requestKey") as HTMLInputElement).value = requestKey.current;
    send(event);
  };

  if (result?.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-ink">Confirm your email</h1>
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">{result.message}</div>
        <p className="text-center text-sm"><Link href="/login" className="text-muted hover:text-ink hover:underline">Go to sign in</Link></p>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <h1 className="text-xl font-bold text-ink">Create your company account</h1>
      <p className="text-sm text-muted">Early access is by invitation. Enter the access code you received.</p>
      {result && !result.ok && <FormError message={result.error} />}
      <input type="hidden" name="requestKey" defaultValue="" />
      <Field label="Access code" htmlFor="accessCode" error={fieldError("accessCode")}>
        <Input id="accessCode" name="accessCode" autoComplete="off" spellCheck={false} placeholder="TLT-XXXXX-XXXXX-XXXXX-XXXXX" required />
      </Field>
      <Field label="Company name" htmlFor="companyName" error={fieldError("companyName")}>
        <Input id="companyName" name="companyName" autoComplete="organization" maxLength={120} required />
      </Field>
      <Field label="Your name" htmlFor="fullName" error={fieldError("fullName")}>
        <Input id="fullName" name="fullName" autoComplete="name" maxLength={120} required />
      </Field>
      <Field label="Email" htmlFor="email" error={fieldError("email")}>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 10 characters." error={fieldError("password")}>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Field label="Confirm password" htmlFor="confirm" error={fieldError("confirm")}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? "Creating account…" : "Create account"}
      </Button>
      <p className="text-center text-sm">
        Already have an account? <Link href="/login" className="font-semibold text-ink hover:underline">Sign in</Link>
      </p>
    </form>
  );
}

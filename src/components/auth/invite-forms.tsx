"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";

// The steps of an invitation page (/join-company, /join-team). The invitation itself is never in a form: the server
// actions read it from this page's cookie and use the invited email from the database, never one typed here.

type Action = (formData: FormData) => Promise<ActionResult>;

function PasswordFields({ id, f }: { id: string; f: ReturnType<typeof useFormAction<undefined>> }) {
  return (
    <>
      <Field label="Choose a password" htmlFor={`${id}-pw`} hint="At least 12 characters." error={f.fieldError("password")}><Input id={`${id}-pw`} name="password" type="password" autoComplete="new-password" minLength={12} required /></Field>
      <Field label="Type it again" htmlFor={`${id}-pw2`} error={f.fieldError("confirm")}><Input id={`${id}-pw2`} name="confirm" type="password" autoComplete="new-password" required /></Field>
    </>
  );
}

/** Choose a password (the link was emailed to this address by Taviron, or the address was just confirmed by the link). */
export function InvitePasswordForm({ id, email, action }: { id: string; email: string; action: Action }) {
  const f = useFormAction(action);
  return (
    <form onSubmit={f.onSubmit} className="space-y-4" aria-label="Choose your password" noValidate>
      <Field label="Email" htmlFor={`${id}-email`}><Input id={`${id}-email`} value={email} readOnly autoComplete="username" /></Field>
      <PasswordFields id={id} f={f} />
      <FormError message={f.formError} />
      <Button type="submit" className="w-full" loading={f.pending}>Continue</Button>
    </form>
  );
}

/**
 * Taviron did not email this link to the address (it was handed over): first a 6-digit code goes to the invited email,
 * then the code and the new password together. Only someone who can read that mailbox gets past this step.
 */
export function InviteEmailCodeForm({ id, email, send, verify }: { id: string; email: string; send: () => Promise<ActionResult>; verify: Action }) {
  const [sent, setSent] = useState(false);
  const ask = useFormAction(async () => send(), { onSuccess: (r) => { setSent(true); toast.success(r.message ?? "Code sent."); } });
  const f = useFormAction(verify);
  if (!sent) {
    return (
      <form onSubmit={ask.onSubmit} className="space-y-4" aria-label="Confirm your email address" noValidate>
        <p className="text-sm text-ink">First confirm that {email} is your email address. We email you a 6-digit code.</p>
        <FormError message={ask.formError} />
        <Button type="submit" className="w-full" loading={ask.pending}>Email me a code</Button>
      </form>
    );
  }
  return (
    <div className="space-y-3">
      <form onSubmit={f.onSubmit} className="space-y-4" aria-label="Enter the code and choose your password" noValidate>
        <p role="status" className="text-sm text-ink">We emailed a 6-digit code to {email}. Enter it here and choose your password. The email can take a minute.</p>
        <Field label="Code from the email" htmlFor={`${id}-code`} error={f.fieldError("code")}><Input id={`${id}-code`} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required /></Field>
        <input type="text" name="username" value={email} readOnly hidden autoComplete="username" />
        <PasswordFields id={id} f={f} />
        <FormError message={f.formError} />
        <Button type="submit" className="w-full" loading={f.pending}>Continue</Button>
      </form>
      <form onSubmit={ask.onSubmit} aria-label="Send a new code">
        <FormError message={ask.formError} />
        <Button type="submit" variant="ghost" size="sm" className="w-full" loading={ask.pending}>No email? Send a new code</Button>
      </form>
    </div>
  );
}

/** An existing Taviron sign-in for the invited email, signed in right here (never another email). */
export function InviteSignInForm({ id, email, action }: { id: string; email: string; action: Action }) {
  const f = useFormAction(action);
  return (
    <form onSubmit={f.onSubmit} className="space-y-4" aria-label="Sign in to accept" noValidate>
      <Field label="Email" htmlFor={`${id}-email`}><Input id={`${id}-email`} value={email} readOnly autoComplete="username" /></Field>
      <Field label="Password" htmlFor={`${id}-pw`} error={f.fieldError("password")}><Input id={`${id}-pw`} name="password" type="password" autoComplete="current-password" required /></Field>
      <FormError message={f.formError} />
      <Button type="submit" className="w-full" loading={f.pending}>Sign in</Button>
    </form>
  );
}

export function InviteAcceptForm({ action, label }: { action: () => Promise<ActionResult>; label: string }) {
  const f = useFormAction(async () => action());
  return (
    <form onSubmit={f.onSubmit} className="space-y-3">
      <FormError message={f.formError} />
      <Button type="submit" className="w-full" loading={f.pending}>{label}</Button>
    </form>
  );
}

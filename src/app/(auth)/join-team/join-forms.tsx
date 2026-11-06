"use client";

import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { acceptTeamInvite, createTeamAccount } from "./actions";

export function CreateAccountForm({ token, email }: { token: string; email: string }) {
  const f = useFormAction(createTeamAccount);
  return (
    <form onSubmit={f.onSubmit} className="space-y-4" aria-label="Choose your password" noValidate>
      <input type="hidden" name="token" value={token} />
      <Field label="Email" htmlFor="jt-email"><Input id="jt-email" value={email} readOnly autoComplete="username" /></Field>
      <Field label="Choose a password" htmlFor="jt-pw" hint="At least 12 characters." error={f.fieldError("password")}><Input id="jt-pw" name="password" type="password" autoComplete="new-password" minLength={12} required /></Field>
      <Field label="Type it again" htmlFor="jt-pw2" error={f.fieldError("confirm")}><Input id="jt-pw2" name="confirm" type="password" autoComplete="new-password" required /></Field>
      <FormError message={f.formError} />
      <Button type="submit" className="w-full" loading={f.pending}>Continue</Button>
    </form>
  );
}

export function AcceptForm({ token }: { token: string }) {
  const f = useFormAction(acceptTeamInvite);
  return (
    <form onSubmit={f.onSubmit} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <FormError message={f.formError} />
      <Button type="submit" className="w-full" loading={f.pending}>Join the Taviron team</Button>
    </form>
  );
}

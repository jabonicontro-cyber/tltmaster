"use client";

import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { acceptOwnerInvite, createOwnerAccount } from "./actions";

export function CreateOwnerAccountForm({ token, email }: { token: string; email: string }) {
  const f = useFormAction(createOwnerAccount);
  return (
    <form onSubmit={f.onSubmit} className="space-y-4" aria-label="Choose your password" noValidate>
      <input type="hidden" name="token" value={token} />
      <Field label="Email" htmlFor="jc-email"><Input id="jc-email" value={email} readOnly autoComplete="username" /></Field>
      <Field label="Choose a password" htmlFor="jc-pw" hint="At least 12 characters." error={f.fieldError("password")}><Input id="jc-pw" name="password" type="password" autoComplete="new-password" minLength={12} required /></Field>
      <Field label="Type it again" htmlFor="jc-pw2" error={f.fieldError("confirm")}><Input id="jc-pw2" name="confirm" type="password" autoComplete="new-password" required /></Field>
      <FormError message={f.formError} />
      <Button type="submit" className="w-full" loading={f.pending}>Continue</Button>
    </form>
  );
}

export function AcceptOwnerForm({ token }: { token: string }) {
  const f = useFormAction(acceptOwnerInvite);
  return (
    <form onSubmit={f.onSubmit} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <FormError message={f.formError} />
      <Button type="submit" className="w-full" loading={f.pending}>Become the owner</Button>
    </form>
  );
}

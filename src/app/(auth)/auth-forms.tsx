"use client";

import Link from "next/link";
import { Field, FormError, Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { useFormAction } from "@/components/ui/use-form-action";
import { requestPasswordReset, signIn, updatePassword } from "./actions";

export function LoginForm({ next, gate = false }: { next?: string; gate?: boolean }) {
  const { pending, onSubmit, result: state } = useFormAction(signIn);
  return (
    <>
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-bold text-ink">Sign in</h1>
      {state && !state.ok && <FormError message={state.error} />}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Email or username" htmlFor="email">
        <Input id="email" name="email" type="text" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" required autoFocus className="h-12 text-base" />
      </Field>
      <Field label="Password" htmlFor="password">
        <PasswordInput id="password" name="password" autoComplete="current-password" required className="h-12 text-base" />
      </Field>
      <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
        <input type="checkbox" name="shared_device" className="size-5 rounded border-line accent-brand" />
        This is a shared computer (sign me out when the browser closes)
      </label>
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-sm">
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center font-semibold text-brand-fg hover:underline">
          Forgot your password?
        </Link>
      </p>
      <details className="rounded-xl bg-surface px-3 py-2 text-sm text-ink">
        <summary className="cursor-pointer font-semibold">First time signing in?</summary>
        <p className="mt-2">
          Use the username and temporary password from the sheet or message your company gave you. Taviron then asks you to create
          your own password — only you will know it. If the temporary password has expired, ask your company for a new sheet.
        </p>
      </details>
      <p className="border-t border-line pt-3 text-center text-sm">
        Have an access code? <Link href="/signup" className="font-semibold text-ink hover:underline">Create a company account</Link>
      </p>
    </form>
    {gate ? (
      // A plain POST: ends this browser's early-access grant (src/app/early-access/leave/route.ts).
      <form action="/early-access/leave" method="post" className="mt-3 text-center">
        <button type="submit" className="text-xs text-muted hover:text-ink hover:underline">
          Remove early access from this browser
        </button>
      </form>
    ) : null}
    </>
  );
}

export function ForgotPasswordForm() {
  const { pending, onSubmit, result: state } = useFormAction(requestPasswordReset);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-bold text-ink">Reset your password</h1>
      <p className="text-sm text-muted">Enter the email you sign in with. We will send a link to choose a new password. If you sign in with a username, ask your administrator for a new link.</p>
      {state && !state.ok && <FormError message={state.error} />}
      {state?.ok && (
        <div role="status" className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
          {state.message}
        </div>
      )}
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="text" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="email" required />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? "Sending…" : "Send reset link"}
      </Button>
      <p className="text-center text-sm">
        <Link href="/login" className="text-muted hover:text-ink hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function UpdatePasswordForm() {
  const { pending, onSubmit, result: state } = useFormAction(updatePassword);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-bold text-ink">Choose a new password</h1>
      {state && !state.ok && <FormError message={state.error} />}
      <Field label="New password" htmlFor="password" hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? "Saving…" : "Save password"}
      </Button>
    </form>
  );
}

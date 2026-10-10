"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { completeOnboarding, createAnotherCompany } from "./actions";

export function FinishCompanyForm({ companyName }: { companyName: string }) {
  const { pending, onSubmit, result, fieldError } = useFormAction(completeOnboarding);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {result && !result.ok && <FormError message={result.error} />}
      <Field label="Company name" htmlFor="companyName" error={fieldError("companyName")} hint="You can change it later in Settings → Company.">
        <Input id="companyName" name="companyName" defaultValue={companyName} maxLength={120} required />
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={pending}>{pending ? "Creating your company…" : "Create my company"}</Button>
    </form>
  );
}

export function AnotherCompanyForm() {
  const [requestKey] = useState(() => crypto.randomUUID());
  const { pending, onSubmit, result } = useFormAction(createAnotherCompany);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {result && !result.ok && <FormError message={result.error} />}
      <input type="hidden" name="requestKey" value={requestKey} />
      <Field label="Access code" htmlFor="accessCode">
        <Input id="accessCode" name="accessCode" autoComplete="off" spellCheck={false} placeholder="TLT-XXXXX-XXXXX-XXXXX-XXXXX" required />
      </Field>
      <Field label="Company name" htmlFor="companyName">
        <Input id="companyName" name="companyName" maxLength={120} required />
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={pending}>{pending ? "Creating…" : "Create company"}</Button>
    </form>
  );
}

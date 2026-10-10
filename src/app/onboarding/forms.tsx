"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { TIMEZONE_OPTIONS } from "@/lib/schemas/settings";
import { useFormAction } from "@/components/ui/use-form-action";
import { completeOnboarding, createAnotherCompany } from "./actions";

/** The business time zone, preselected from this browser when it is one of the options (never assumed on the server). */
function TimezoneField({ error }: { error?: string }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's zone is only known after mount
    if (TIMEZONE_OPTIONS.some((t) => t.value === local)) setValue(local);
  }, []);
  return (
    <Field label="Time zone" htmlFor="timezone" error={error} hint="Decides what “today” means for loads and tickets. You can change it later in Settings → Company.">
      <Select id="timezone" name="timezone" value={value} onChange={(e) => setValue(e.target.value)} required>
        <option value="">Choose…</option>
        {TIMEZONE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </Select>
    </Field>
  );
}

export function FinishCompanyForm({ companyName }: { companyName: string }) {
  const { pending, onSubmit, result, fieldError } = useFormAction(completeOnboarding);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {result && !result.ok && <FormError message={result.error} />}
      <Field label="Company name" htmlFor="companyName" error={fieldError("companyName")} hint="You can change it later in Settings → Company.">
        <Input id="companyName" name="companyName" defaultValue={companyName} maxLength={120} required />
      </Field>
      <TimezoneField error={fieldError("timezone")} />
      <Button type="submit" size="lg" className="w-full" loading={pending}>{pending ? "Creating your company…" : "Create my company"}</Button>
    </form>
  );
}

export function AnotherCompanyForm() {
  const [requestKey] = useState(() => crypto.randomUUID());
  const { pending, onSubmit, result, fieldError } = useFormAction(createAnotherCompany);
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
      <TimezoneField error={fieldError("timezone")} />
      <Button type="submit" size="lg" className="w-full" loading={pending}>{pending ? "Creating…" : "Create company"}</Button>
    </form>
  );
}

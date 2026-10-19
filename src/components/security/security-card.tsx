"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { generateRecoveryCodes, removeAuthenticator } from "@/app/mfa/actions";

/** My profile → Security: two-step verification status, recovery codes, removal (when no policy requires it). */
export function SecurityCard({ enrolled, aal2, required, reason, recoveryLeft, installed, events }: {
  enrolled: boolean; aal2: boolean; required: boolean; reason: string | null; recoveryLeft: number; installed: boolean;
  events: Array<{ event: string; at: string }>;
}) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useFormAction(removeAuthenticator, { onSuccess: (r) => { toast.success(r.message ?? "Removed."); router.refresh(); } });
  return (
    <section aria-label="Security">
      <CardHeader
        title="Security"
        description="Two-step verification asks for a code from your phone after your password."
        actions={<Badge tone={enrolled ? "green" : required ? "amber" : "gray"}>{enrolled ? "Two-step on" : required ? "Required — not set up" : "Two-step off"}</Badge>}
      />
      <div className="space-y-4 px-4 pb-5 text-sm sm:px-5">
        {reason ? <p className="text-muted">{reason}</p> : null}
        {!enrolled ? (
          <Link href="/mfa?next=/profile" className={buttonClasses("primary")}>Set Up Two-Step Verification</Link>
        ) : (
          <>
            {installed ? (
              <div className="space-y-2">
                <p className="text-muted">{recoveryLeft} unused recovery {recoveryLeft === 1 ? "code" : "codes"}. Creating new ones cancels the old ones.</p>
                <FormError message={error} />
                {aal2 ? (
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError(null);
                      const r = await generateRecoveryCodes();
                      setBusy(false);
                      if (r.ok) setCodes(r.data.codes);
                      else setError(r.error);
                    }}
                  >
                    Create New Recovery Codes
                  </Button>
                ) : (
                  <Link href="/mfa?next=/profile" className={buttonClasses("secondary")}>Verify to Manage</Link>
                )}
                {codes ? (
                  <ol className="grid grid-cols-2 gap-2 rounded-md border border-line bg-surface p-3 font-mono" aria-label="New recovery codes">
                    {codes.map((c) => <li key={c}>{c}</li>)}
                  </ol>
                ) : null}
              </div>
            ) : null}
            {!required && aal2 ? (
              <form onSubmit={remove.onSubmit} className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
                <FormError message={remove.formError} />
                <Field label="Password, to turn two-step verification off" htmlFor="mfa-off-password" error={remove.fieldError("password")}>
                  <Input id="mfa-off-password" name="password" type="password" autoComplete="current-password" required />
                </Field>
                <Button type="submit" variant="secondary" loading={remove.pending}>Turn Off</Button>
              </form>
            ) : null}
          </>
        )}
        {events.length ? (
          <details>
            <summary className="cursor-pointer text-muted">Recent security events</summary>
            <ul className="mt-2 space-y-1 text-muted">
              {events.slice(0, 10).map((e, i) => (
                <li key={i}>{EVENT_LABELS[e.event] ?? e.event} · {new Date(e.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

const EVENT_LABELS: Record<string, string> = {
  "mfa.enrolled": "Authenticator set up",
  "mfa.verified": "Verified with authenticator",
  "mfa.removed": "Authenticator removed",
  "mfa.challenge_failed": "Wrong code entered",
  "mfa.recovery_generated": "Recovery codes created",
  "mfa.recovery_used": "Recovery code used",
  "mfa.recovery_failed": "Wrong recovery code",
  "mfa.company_policy": "Company policy changed",
};

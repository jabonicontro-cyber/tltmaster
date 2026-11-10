"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { confirmRecoveryCodes, generateRecoveryCodes, sendPhoneCode, startEnrollment, startPhoneEnrollment, redeemRecoveryCode, verifyCode } from "@/app/mfa/actions";
import { PhoneInput } from "@/components/ui/phone-input";

/**
 * A code texted to the phone (B109): "Text me a code", then the code from the text. Used to finish setting up a
 * phone and to verify at sign-in.
 */
function PhoneCode({ next, start, factorId, label, onVerified }: {
  next: string;
  /** Already sent (setup): the challenge to answer. */
  start?: { factorId: string; challengeId: string; phone?: string };
  factorId?: string;
  label: string;
  onVerified: (next: string) => void;
}) {
  const [sent, setSent] = useState(start ?? null);
  const send = useFormAction(sendPhoneCode, { onSuccess: (r) => setSent(r.data) });
  const verify = useFormAction(verifyCode, { onSuccess: (r) => onVerified(r.data.next) });
  if (!sent) {
    return (
      <form onSubmit={send.onSubmit} className="space-y-4" aria-label="Text me a code">
        <FormError message={send.formError} />
        {factorId && <input type="hidden" name="factorId" value={factorId} />}
        <Button type="submit" className="w-full" size="lg" loading={send.pending}>Text Me a Code</Button>
      </form>
    );
  }
  return (
    <div className="space-y-3">
      <form onSubmit={verify.onSubmit} className="space-y-4" aria-label={label}>
        <FormError message={verify.formError} />
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="factorId" value={sent.factorId} />
        <input type="hidden" name="challengeId" value={sent.challengeId} />
        <p className="text-sm text-muted">We texted a 6-digit code{start?.phone ? ` to ${start.phone}` : " to your phone"}. It works for a few minutes.</p>
        <Field label="6-digit code" htmlFor="sms-code" error={verify.fieldError("code")}>
          <Input id="sms-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus className="tabular text-lg tracking-[0.3em]" />
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={verify.pending}>Verify</Button>
      </form>
      <form onSubmit={send.onSubmit}>
        <FormError message={send.formError} />
        <input type="hidden" name="factorId" value={sent.factorId} />
        <button type="submit" className="w-full text-center text-sm text-muted hover:text-ink hover:underline" disabled={send.pending}>Send a new code</button>
      </form>
    </div>
  );
}

/** Enter the 6-digit code for an existing authenticator app, or a texted code when the account uses a phone. */
export function MfaChallenge({ next, kind = "totp" }: { next: string; kind?: "totp" | "phone" }) {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const verify = useFormAction(verifyCode, { onSuccess: (r) => router.replace(r.data.next) });
  const recover = useFormAction(redeemRecoveryCode);
  if (recovery) {
    return (
      <form onSubmit={recover.onSubmit} className="space-y-4" aria-label="Use a recovery code">
        <FormError message={recover.formError} />
        <p className="text-sm text-muted">A recovery code removes your lost authenticator so you can set up a new one right away. Each code works once.</p>
        <Field label="Recovery code" htmlFor="recovery-code">
          <Input id="recovery-code" name="code" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} placeholder="xxxxx-xxxxx" required />
        </Field>
        <Button type="submit" className="w-full" loading={recover.pending}>Use Recovery Code</Button>
        <button type="button" onClick={() => setRecovery(false)} className="w-full text-center text-sm text-muted hover:text-ink hover:underline">Back to the authenticator code</button>
      </form>
    );
  }
  if (kind === "phone") {
    return (
      <div className="space-y-4">
        <PhoneCode next={next} label="Verify with a texted code" onVerified={(n) => router.replace(n)} />
        <button type="button" onClick={() => setRecovery(true)} className="w-full text-center text-sm text-muted hover:text-ink hover:underline">Lost your phone? Use a recovery code</button>
      </div>
    );
  }
  return (
    <form onSubmit={verify.onSubmit} className="space-y-4" aria-label="Verify with your authenticator app">
      <FormError message={verify.formError} />
      <input type="hidden" name="next" value={next} />
      <Field label="6-digit code" htmlFor="code" error={verify.fieldError("code")}>
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus className="tabular text-lg tracking-[0.3em]" />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={verify.pending}>Verify</Button>
      <button type="button" onClick={() => setRecovery(true)} className="w-full text-center text-sm text-muted hover:text-ink hover:underline">Lost your phone? Use a recovery code</button>
    </form>
  );
}

/** Set up text-message codes: the mobile number, then the texted code. */
function PhoneEnroll({ next, onBack }: { next: string; onBack: () => void }) {
  const router = useRouter();
  const [sent, setSent] = useState<{ factorId: string; challengeId: string; phone: string } | null>(null);
  const start = useFormAction(startPhoneEnrollment, { onSuccess: (r) => setSent(r.data) });
  if (sent) return <PhoneCode next={next} start={sent} label="Confirm your phone" onVerified={() => router.refresh()} />;
  return (
    <form onSubmit={start.onSubmit} className="space-y-4" aria-label="Set up text-message codes">
      <FormError message={start.formError} />
      <p className="text-sm text-muted">We text a 6-digit code to this number each time you sign in where verification is needed. Message and data rates may apply.</p>
      <Field label="Mobile number" htmlFor="mfa-phone" error={start.fieldError("phone")}>
        <PhoneInput id="mfa-phone" name="phone" autoComplete="tel" required />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={start.pending}>Text Me a Code</Button>
      <button type="button" onClick={onBack} className="w-full text-center text-sm text-muted hover:text-ink hover:underline">Use an authenticator app instead</button>
    </form>
  );
}

/** Set up an authenticator: QR code (or secret), confirm with a code, then save recovery codes. With text messages
 * allowed on this server (B109), a phone can be chosen instead. */
export function MfaEnroll({ next, smsAllowed = false }: { next: string; smsAllowed?: boolean }) {
  const [usePhone, setUsePhone] = useState(false);
  if (usePhone) return <PhoneEnroll next={next} onBack={() => setUsePhone(false)} />;
  return <AppEnroll next={next} onPhone={smsAllowed ? () => setUsePhone(true) : undefined} />;
}

function AppEnroll({ next, onPhone }: { next: string; onPhone?: () => void }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // The page then shows the recovery-codes step (RecoveryCodesStep) for the verified session.
  const verify = useFormAction(verifyCode, { onSuccess: () => router.refresh() });

  if (!setup) {
    return (
      <div className="space-y-4">
        <FormError message={startError} />
        <div className="rounded-xl border border-line bg-surface p-3 text-sm">
          <p className="font-semibold text-ink">What you need</p>
          <p className="mt-1 text-muted">Your phone with a free authenticator app. Any of these works: Google Authenticator, Microsoft Authenticator, 1Password or Authy. If you do not have one yet, install it from your phone&apos;s app store first.</p>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted" aria-label="Steps">
          <li>Press <span className="font-medium text-ink">Set Up Authenticator App</span> below. A square code appears.</li>
          <li>In the app on your phone, add an account and scan the square code.</li>
          <li>Type the 6-digit code the app then shows.</li>
          <li>Save your recovery codes. They get you back in if you lose your phone.</li>
        </ol>
        <Button
          className="w-full"
          size="lg"
          loading={starting}
          onClick={async () => {
            setStarting(true);
            setStartError(null);
            const r = await startEnrollment();
            setStarting(false);
            if (r.ok) setSetup(r.data);
            else setStartError(r.error);
          }}
        >
          Set Up Authenticator App
        </Button>
        {onPhone && (
          <button type="button" onClick={onPhone} className="w-full text-center text-sm font-semibold text-brand-fg hover:underline">
            No authenticator app? Get codes by text message
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={verify.onSubmit} className="space-y-4" aria-label="Confirm your authenticator app">
      <FormError message={verify.formError} />
      <input type="hidden" name="factorId" value={setup.factorId} />
      <input type="hidden" name="next" value={next} />
      <p className="text-sm text-muted">In your authenticator app, tap <span className="font-medium text-ink">Add</span> (or <span className="font-medium text-ink">+</span>), choose to scan a QR code, and point your phone at this code.</p>
      <div className="flex justify-center rounded-xl bg-white p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- an SVG data URL generated by Supabase Auth */}
        <img src={setup.qr} alt="QR code for your authenticator app" className="size-44" />
      </div>
      <Field label="Or type this key" htmlFor="secret" hint="Cannot scan? In the app, choose to enter a setup key and type this one.">
        <Input id="secret" readOnly value={setup.secret} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <Field label="6-digit code from the app" htmlFor="code" hint="The code changes every 30 seconds. Type the one showing now." error={verify.fieldError("code")}>
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required className="tabular text-lg tracking-[0.3em]" />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={verify.pending}>Turn On Two-Step Verification</Button>
    </form>
  );
}

/**
 * Right after setup (verified session, no recovery codes yet): create them and show them once. With money access
 * (required) there is no "Later", and continuing needs the person to tick that they saved them; the server records it
 * and opens nothing until then (owner 2026-11-10).
 */
export function RecoveryCodesStep({ next, required = false, replacing = false }: { next: string; required?: boolean; replacing?: boolean }) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = async () => {
    setBusy(true);
    setError(null);
    const r = await confirmRecoveryCodes();
    setBusy(false);
    if (r.ok || !required) router.replace(next);
    else setError(r.error);
  };
  if (!codes) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink">
          {replacing
            ? "Your recovery codes were not confirmed as saved. Create a new set now; the earlier codes stop working."
            : "Two-step verification is on. Now create your recovery codes."}
        </p>
        <p className="text-sm text-muted">If you lose or replace your phone, a recovery code lets you back in once, so you can set up the new phone. Without one you cannot get back in on your own.</p>
        {required ? <p className="text-sm text-muted">Because your account can see or change money, this step is required before you continue.</p> : null}
        <FormError message={error} />
        <Button
          className="w-full"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            const r = await generateRecoveryCodes();
            setBusy(false);
            if (r.ok) setCodes(r.data.codes);
            else setError(r.error);
          }}
        >
          Create Recovery Codes
        </Button>
        {required ? null : (
          <button type="button" onClick={() => router.replace(next)} className="w-full text-center text-sm text-muted hover:text-ink hover:underline">Later (from My profile)</button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-ink">Save these recovery codes now.</p>
      <p className="text-sm text-muted">Each code works once. Keep them somewhere safe away from your phone: print them, or save them in a password manager. They are not shown again; you can create new ones from My profile.</p>
      <ol className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface p-3 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      {required ? <Checkbox name="saved" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} label="I saved these codes somewhere safe" /> : null}
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => navigator.clipboard.writeText(codes.join("\n"))}>Copy Codes</Button>
        <Button onClick={finish} loading={busy} disabled={required && !saved}>I Saved Them, Continue</Button>
      </div>
    </div>
  );
}

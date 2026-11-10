import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { MfaChallenge, MfaEnroll, RecoveryCodesStep } from "@/components/security/mfa-flow";
import { PRODUCT_NAME } from "@/lib/product";
import { safeNextPath } from "@/lib/safe-redirect";
import { mfaState } from "@/server/mfa";
import { env } from "@/server/env";
import { createClient } from "@/server/supabase/server";
import { signOut } from "@/app/(auth)/actions";

export const metadata = { title: "Two-Step Verification" };

/**
 * Two-step verification: set up an authenticator app, or enter its code to continue. Reached when a page requires it
 * (platform administrators and anyone with money access in a real company always; company members when their company
 * requires it) or from My profile.
 */
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string; setup?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login?next=/mfa");
  const next = safeNextPath(sp.next, "/command-center");
  const { data: list } = await supabase.auth.mfa.listFactors();
  const hasApp = (list?.totp ?? []).length > 0;
  const hasPhone = (list?.phone ?? []).length > 0;
  const verified = hasApp || hasPhone;
  const state = await mfaState();
  // Text-message codes (B109): only when the server allows them, never for platform administrators.
  const smsAllowed = env().MFA_SMS && !state.policy?.platform;
  const done = verified && state.aal === "aal2";
  // Recovery codes: offered to everyone after setup; required (no "Later") for money access, until the person confirms
  // they saved the newest set (owner 2026-11-10; every page and action waits for it, src/server/mfa.ts).
  const codesRequired = state.policy?.money === true;
  const needsCodes = done && state.installed && ((state.policy?.recovery_codes ?? 0) === 0 || state.recoveryPending);

  return (
    // Same frame as sign-in (src/app/(auth)/layout.tsx): Taviron's mark on the dark background, one card.
    <div className="app-root flex min-h-dvh flex-col bg-charcoal text-ink">
      <div className="h-1.5 bg-brand" />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <a href={PUBLIC_WEBSITE_URL} aria-label="Taviron website" className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
            <BrandMark className="scale-125" />
          </a>
        </div>
      <div className="rounded-2xl bg-card p-6 shadow-xl">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <ShieldCheck className="size-5 shrink-0 text-brand-fg" aria-hidden />
          {needsCodes ? "One last step: recovery codes" : done ? "You are verified" : verified ? "Enter your code" : "Set up two-step verification"}
        </h1>
        <div className="mt-1 mb-5 space-y-2 text-sm">
          {sp.reset ? <p className="text-ink">Your lost authenticator was removed. Set up a new one now.</p> : null}
          {state.reason && !done ? <p className="font-medium text-ink">{state.reason}</p> : null}
          {!verified ? (
            // First time (owner rule "easy for anyone"): what it is and why, in plain words, before any step.
            <p className="text-muted">After your password, Taviron asks for a 6-digit code from an app on your phone. Someone who learns your password still cannot get in without your phone.</p>
          ) : !done ? (
            <p className="text-muted">{hasApp ? "Open the authenticator app on your phone and type the 6-digit code it shows for Taviron." : "We text a 6-digit code to your phone."}</p>
          ) : null}
        </div>
        {needsCodes ? (
          <RecoveryCodesStep next={next} required={codesRequired} replacing={(state.policy?.recovery_codes ?? 0) > 0} />
        ) : done ? (
          <Link href={next} className="font-semibold text-brand-fg hover:underline">Continue</Link>
        ) : verified ? (
          <MfaChallenge next={next} kind={hasApp ? "totp" : "phone"} />
        ) : (
          <MfaEnroll next={next} smsAllowed={smsAllowed} />
        )}
        <form action={signOut} className="mt-6 border-t border-line pt-4 text-center">
          <button type="submit" className="text-sm text-muted hover:text-ink hover:underline">Sign out</button>
        </form>
      </div>
        <p className="mt-6 text-center text-xs text-white/50">{PRODUCT_NAME} · Authorized users only</p>
      </div>
      </main>
    </div>
  );
}

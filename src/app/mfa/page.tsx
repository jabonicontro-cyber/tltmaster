import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { MfaChallenge, MfaEnroll, RecoveryCodesStep } from "@/components/security/mfa-flow";
import { PRODUCT_NAME } from "@/lib/product";
import { safeNextPath } from "@/lib/safe-redirect";
import { mfaState } from "@/server/mfa";
import { createClient } from "@/server/supabase/server";
import { signOut } from "@/app/(auth)/actions";

export const metadata = { title: "Two-Step Verification" };

/**
 * Two-step verification: set up an authenticator app, or enter its code to continue. Reached when a page requires it
 * (platform administrators always; company members when their company requires it) or from My profile.
 */
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string; setup?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login?next=/mfa");
  const next = safeNextPath(sp.next, "/command-center");
  const { data: list } = await supabase.auth.mfa.listFactors();
  const verified = (list?.totp ?? []).length > 0;
  const state = await mfaState();
  const done = verified && state.aal === "aal2";
  const needsCodes = done && state.installed && (state.policy?.recovery_codes ?? 0) === 0;

  return (
    <main id="main" className="app-root flex min-h-dvh items-center justify-center bg-surface px-4 py-10 text-ink">
      <div className="w-full max-w-sm rounded-lg border border-line bg-card p-6">
        <div className="mb-4 flex items-center gap-2 text-brand-fg">
          <ShieldCheck className="size-6" aria-hidden />
          <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
        </div>
        <h1 className="text-xl font-bold">{done ? "You Are Verified" : verified ? "Enter Your Code" : "Set Up Two-Step Verification"}</h1>
        <p className="mt-1 mb-5 text-sm text-muted">
          {sp.reset ? "Your lost authenticator was removed. Set up a new one now. " : ""}
          {state.reason ?? (verified ? "Open your authenticator app for the current code." : "Protect your account with a code from your phone, in addition to your password.")}
        </p>
        {needsCodes ? (
          <RecoveryCodesStep next={next} />
        ) : done ? (
          <Link href={next} className="font-semibold text-brand-fg hover:underline">Continue</Link>
        ) : verified ? (
          <MfaChallenge next={next} />
        ) : (
          <MfaEnroll next={next} />
        )}
        <form action={signOut} className="mt-6 border-t border-line pt-4 text-center">
          <button type="submit" className="text-sm text-muted hover:text-ink hover:underline">Sign out</button>
        </form>
      </div>
    </main>
  );
}

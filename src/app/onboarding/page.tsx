import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/layout/brand";
import { buttonClasses } from "@/components/ui/button";
import { getAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";
import { AnotherCompanyForm, FinishCompanyForm } from "./forms";

export const metadata: Metadata = { title: "Set up your company" };

export default async function OnboardingPage() {
  const access = await getAccess();
  if (!access) redirect("/login?next=/onboarding");
  const supabase = await createClient();
  const { data } = await supabase.rpc("my_onboarding");
  const state = (data ?? {}) as { email_verified?: boolean; pending_company?: string | null; membership_count?: number };

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-md rounded-panel border border-line/70 bg-card shadow-card p-6 shadow-sm">
        <div className="mb-4 flex justify-center"><BrandMark tone="dark" /></div>
        {state.pending_company ? (
          <>
            <h1 className="text-xl font-bold">Create your company</h1>
            <p className="mt-1 mb-4 text-sm text-muted">Signed in as <strong>{access.email}</strong>. You will be its owner and can invite your office staff, dispatchers, mechanics and drivers next.</p>
            <FinishCompanyForm companyName={state.pending_company} />
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold">Create a company</h1>
            <p className="mt-1 mb-4 text-sm text-muted">
              {state.membership_count ? "Add another company to your account with an access code. Its data stays separate; switch between companies from the account menu." : "Your account does not belong to a company yet. If your employer uses this app, ask them to invite you. To set up your own company, enter your access code."}
            </p>
            <AnotherCompanyForm />
          </>
        )}
        <div className="mt-4 text-center text-sm">
          {state.membership_count ? <Link href="/command-center" className={buttonClasses("ghost", "sm")}>Back to the app</Link> : null}
        </div>
      </div>
    </main>
  );
}

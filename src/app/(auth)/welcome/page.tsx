import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { homePathFor } from "@/lib/accounts";
import { getAccess } from "@/server/auth";
import { mySetup } from "@/server/setup";
import { createClient } from "@/server/supabase/server";
import { signOut } from "../actions";
import { signOutOfPortal } from "@/app/portal/actions";
import { FirstSignInForm } from "./welcome-form";

export const metadata: Metadata = { title: "Create your password" };

/** First sign-in: explain, then the person chooses their own password (docs/ACCOUNT_PROVISIONING.md). */
/** Customers sign out back to their company's portal, staff to the main sign-in. */
function SignOutForm({ slug, children, className }: { slug: string | null; children: React.ReactNode; className?: string }) {
  return (
    <form action={slug ? signOutOfPortal : signOut} className={className}>
      {slug ? <input type="hidden" name="slug" value={slug} /> : null}
      {children}
    </form>
  );
}

export default async function WelcomePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  const setup = await mySetup();
  if (!setup?.required) {
    if (setup?.kind === "portal" && setup.slug) redirect(`/portal/${setup.slug}`);
    const access = await getAccess();
    redirect(homePathFor(access?.role ?? null, access?.permissions ?? []));
  }
  if (setup.expired) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-ink">This temporary sign-in has expired</h1>
        <p className="text-sm text-ink">
          Ask {setup.company ?? "your administrator"} for a new sign-in sheet. The new one replaces this temporary password.
        </p>
        <SignOutForm slug={setup.kind === "portal" ? setup.slug ?? null : null}>
          <button type="submit" className="w-full rounded-md border border-line px-4 py-3 text-base font-semibold text-ink hover:bg-surface">Sign out</button>
        </SignOutForm>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink">Welcome{setup.company ? ` to ${setup.company}` : ""}</h1>
        <p className="mt-1 text-sm text-ink">
          You signed in with a temporary password. Create your own password now — only you will know it. Next time, sign in with
          your username <strong className="font-semibold">{setup.username}</strong> and this new password.
        </p>
      </div>
      <FirstSignInForm />
      <SignOutForm slug={setup.kind === "portal" ? setup.slug ?? null : null} className="border-t border-line pt-3 text-center">
        <button type="submit" className="text-sm text-muted hover:text-ink hover:underline">Not you? Sign out</button>
      </SignOutForm>
    </div>
  );
}

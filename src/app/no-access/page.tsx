import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { buttonClasses } from "@/components/ui/button";
import { getAccess } from "@/server/auth";
import { signOut } from "@/app/(auth)/actions";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";

export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ missing?: string }> }) {
  const access = await getAccess();
  if (!access) redirect("/login");
  const { missing } = await searchParams;
  // A verified account with a company waiting from sign-up goes to finish it.
  if (!access.role) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("my_onboarding");
    if ((data as { pending_company?: string | null } | null)?.pending_company) redirect("/onboarding");
  }
  const pending = !access.role || !access.active;

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-card p-6 text-center shadow-sm">
        <div className="mb-4 flex justify-center">
          <BrandMark tone="dark" />
        </div>
        {pending ? (
          <>
            <h1 className="text-lg font-bold">Your account is waiting for access</h1>
            <p className="mt-2 text-sm text-muted">
              You are signed in as <strong>{access.email}</strong>, but an owner has not assigned you a role yet
              {access.active ? "" : " or your account has been deactivated"}. Ask the business owner to grant access in People → Sign-ins &amp; roles.
            </p>
            <p className="mt-2 text-sm text-muted">
              Setting up your own company? <Link href="/onboarding" className="font-semibold text-ink underline">Create a company with an access code</Link>.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-bold">You do not have access to that page</h1>
            <p className="mt-2 text-sm text-muted">
              Your role does not include the permission needed{missing ? ` (${missing})` : ""}. Ask an owner if you need it.
            </p>
          </>
        )}
        <div className="mt-5 flex justify-center gap-2">
          {!pending && (
            <Link href="/command-center" className={buttonClasses("primary")}>
              Go to the start page
            </Link>
          )}
          <form action={signOut}>
            <button type="submit" className={buttonClasses("secondary")}>
              Sign out
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

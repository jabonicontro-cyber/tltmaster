import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { mfaState } from "@/server/mfa";
import { createClient } from "@/server/supabase/server";
import { peekOwnerInvite } from "./actions";
import { AcceptOwnerForm, CreateOwnerAccountForm } from "./join-forms";

export const metadata = { title: "Set up your company" };
export const dynamic = "force-dynamic";

const CLOSED: Record<string, string> = {
  used: "This invitation has already been used. Sign in as usual.",
  withdrawn: "This invitation was withdrawn. Ask Taviron for a new one.",
  expired: "This invitation has expired. Ask Taviron for a new one.",
  closed: "This invitation can no longer be used: the company already has an owner or is closed. Sign in as usual, or ask Taviron.",
  invalid: "This invitation link is not valid. Open it again from the email, or ask Taviron for a new one.",
};

/**
 * Becoming a company's first owner (PC2): three short steps from the invitation link. 1. Choose a password (or sign in
 * if you already have a Taviron sign-in). 2. Set up an authenticator app. 3. Accept. The database checks each step again.
 */
export default async function JoinCompanyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? "";
  const inv = await peekOwnerInvite(token);
  const here = `/join-company?token=${token}`;
  if (inv.status !== "open" || !inv.email) {
    return (
      <>
        <h1 className="text-xl font-bold">Set up your company</h1>
        <p className="mt-2 text-sm text-muted">{CLOSED[inv.status] ?? CLOSED.invalid}</p>
        <Link href="/login" className={buttonClasses("secondary", "md", "mt-5 w-full")}>Go to sign-in</Link>
      </>
    );
  }
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const signedInEmail = claims?.claims?.email ? String(claims.claims.email).toLowerCase() : null;
  const intro = (
    <>
      <h1 className="text-xl font-bold">Set up {inv.company_name}</h1>
      <p className="mt-1 mb-5 text-sm text-muted">
        {inv.full_name ? `${inv.full_name}, you` : "You"} are invited to be the owner of {inv.company_name} in Taviron. The invitation works until {formatDateTime(inv.expires_at!)}.
      </p>
    </>
  );

  if (!signedInEmail) {
    return (
      <>
        {intro}
        <Steps at={1} />
        {inv.has_account ? (
          <>
            <p className="mb-4 text-sm text-ink">You already have a Taviron sign-in for {inv.email}. Sign in with it to continue.</p>
            <Link href={`/login?next=${encodeURIComponent(here)}`} className={buttonClasses("primary", "md", "w-full")}>Sign in</Link>
          </>
        ) : (
          <CreateOwnerAccountForm token={token} email={inv.email} />
        )}
      </>
    );
  }
  if (signedInEmail !== inv.email) {
    return (
      <>
        {intro}
        <p className="text-sm text-ink">You are signed in as {signedInEmail}, but this invitation is for {inv.email}. Sign out, then open the link again.</p>
      </>
    );
  }
  const mfa = await mfaState();
  const verified = mfa.aal === "aal2" && mfa.enrolled;
  return (
    <>
      {intro}
      <Steps at={verified ? 3 : 2} />
      {verified ? (
        <>
          <p className="mb-4 text-sm text-ink">Last step. As the owner you can see and change everything in {inv.company_name}, and you add your team from People.</p>
          <AcceptOwnerForm token={token} />
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-ink">Next, protect your account with a code from an authenticator app on your phone (for example Google Authenticator or 1Password). The owner of a company needs one.</p>
          <Link href={`/mfa?next=${encodeURIComponent(here)}`} className={buttonClasses("primary", "md", "w-full")}>Set up the authenticator app</Link>
        </>
      )}
    </>
  );
}

function Steps({ at }: { at: 1 | 2 | 3 }) {
  const steps = ["Password", "Authenticator", "Accept"];
  return (
    <ol className="mb-5 flex gap-2 text-xs" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} aria-current={i + 1 === at ? "step" : undefined} className={`flex-1 rounded-full px-2 py-1 text-center font-semibold whitespace-nowrap ${i + 1 < at ? "bg-surface text-muted line-through" : i + 1 === at ? "bg-strong text-white" : "bg-surface text-muted"}`}>
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

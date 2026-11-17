import Link from "next/link";
import { InviteAcceptForm, InviteEmailCodeForm, InvitePasswordForm, InviteSignInForm } from "@/components/auth/invite-forms";
import { buttonClasses } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { needsInvitedPassword } from "@/server/invite-account";
import { readInviteToken } from "@/server/invite-token";
import { mfaState } from "@/server/mfa";
import { createClient } from "@/server/supabase/server";
import { acceptOwnerInvite, chooseOwnerPassword, createOwnerAccount, peekOwnerInvite, sendOwnerEmailCode, signInToAcceptOwner, verifyOwnerEmailCode } from "./actions";

export const metadata = { title: "Set up your company" };
export const dynamic = "force-dynamic";

const HERE = "/join-company";

const CLOSED: Record<string, string> = {
  used: "This invitation has already been used. Sign in as usual.",
  withdrawn: "This invitation was withdrawn. Ask Taviron for a new one.",
  expired: "This invitation has expired. Ask Taviron for a new one.",
  closed: "This invitation can no longer be used: the company already has an owner or is closed. Sign in as usual, or ask Taviron.",
  invalid: "This invitation link is not valid, or this browser has not opened it yet. Open the link from the email again, or ask Taviron for a new one.",
};

/**
 * Becoming a company's first owner (PC2): three short steps from the invitation link. 1. Choose a password (or sign in
 * with the Taviron sign-in you already have); when Taviron did not email the link to this address, a code emailed to it
 * confirms the address first. 2. Set up an authenticator app. 3. Accept. The database checks each step again. The
 * link's token is kept in a cookie for this page only (src/lib/invite-cookie.ts); this address never carries it.
 */
export default async function JoinCompanyPage() {
  const inv = await peekOwnerInvite(await readInviteToken(HERE));
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
            <InviteSignInForm id="jc-signin" email={inv.email} action={signInToAcceptOwner} />
          </>
        ) : inv.link_emailed ? (
          <InvitePasswordForm id="jc" email={inv.email} action={createOwnerAccount} />
        ) : (
          <InviteEmailCodeForm id="jc" email={inv.email} send={sendOwnerEmailCode} verify={verifyOwnerEmailCode} />
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
  if (await needsInvitedPassword()) {
    return (
      <>
        {intro}
        <Steps at={1} />
        <p className="mb-4 text-sm text-ink">Your email address is confirmed. Now choose your password.</p>
        <InvitePasswordForm id="jc" email={inv.email} action={chooseOwnerPassword} />
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
          <InviteAcceptForm action={acceptOwnerInvite} label="Become the owner" />
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-ink">
            {mfa.enrolled
              ? "Next, enter the code from your authenticator app."
              : "Next, protect your account with a code from an authenticator app on your phone (for example Google Authenticator or 1Password). The owner of a company needs one."}
          </p>
          <Link href={`/mfa?next=${encodeURIComponent(HERE)}`} className={buttonClasses("primary", "md", "w-full")}>
            {mfa.enrolled ? "Enter the authenticator code" : "Set up the authenticator app"}
          </Link>
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

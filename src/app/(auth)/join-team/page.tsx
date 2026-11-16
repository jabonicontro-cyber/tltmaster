import Link from "next/link";
import { InviteAcceptForm, InviteEmailCodeForm, InvitePasswordForm, InviteSignInForm } from "@/components/auth/invite-forms";
import { buttonClasses } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { needsInvitedPassword } from "@/server/invite-account";
import { readInviteToken } from "@/server/invite-token";
import { mfaState } from "@/server/mfa";
import { createClient } from "@/server/supabase/server";
import { acceptTeamInvite, chooseTeamPassword, createTeamAccount, peekInvite, sendTeamEmailCode, signInToJoinTeam, verifyTeamEmailCode } from "./actions";

export const metadata = { title: "Join the Taviron team" };
export const dynamic = "force-dynamic";

const HERE = "/join-team";
const LEVEL = { admin: "Admin", support: "Support" } as const;
const CLOSED: Record<string, string> = {
  used: "This invitation has already been used. Sign in as usual.",
  withdrawn: "This invitation was withdrawn. Ask the person who invited you for a new one.",
  expired: "This invitation has expired. Ask the person who invited you for a new one.",
  invalid: "This invitation link is not valid, or this browser has not opened it yet. Open the link from the email again, or ask for a new one.",
};

/**
 * Joining the Taviron team (SA1): three short steps from the invitation link. 1. Choose a password (or sign in with the
 * Taviron sign-in you already have); when the link was not emailed to this address by Taviron, a code emailed to it
 * confirms the address first. 2. Set up an authenticator app. 3. Join. The database checks each step again. The link's
 * token is kept in a cookie for this page only (src/lib/invite-cookie.ts); this address never carries it.
 */
export default async function JoinTeamPage() {
  const inv = await peekInvite(await readInviteToken(HERE));
  if (inv.status !== "open" || !inv.email) {
    return (
      <>
        <h1 className="text-xl font-bold">Join the Taviron team</h1>
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
      <h1 className="text-xl font-bold">Join the Taviron team</h1>
      <p className="mt-1 mb-5 text-sm text-muted">
        {inv.full_name ? `${inv.full_name}, you` : "You"} are invited as {LEVEL[inv.level ?? "support"]}. The invitation works until {formatDateTime(inv.expires_at!)}.
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
            <InviteSignInForm id="jt-signin" email={inv.email} action={signInToJoinTeam} />
          </>
        ) : inv.link_emailed ? (
          <InvitePasswordForm id="jt" email={inv.email} action={createTeamAccount} />
        ) : (
          <InviteEmailCodeForm id="jt" email={inv.email} send={sendTeamEmailCode} verify={verifyTeamEmailCode} />
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
        <InvitePasswordForm id="jt" email={inv.email} action={chooseTeamPassword} />
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
        <InviteAcceptForm action={acceptTeamInvite} label="Join the Taviron team" />
      ) : (
        <>
          <p className="mb-4 text-sm text-ink">
            {mfa.enrolled
              ? "Next, enter the code from your authenticator app."
              : "Next, protect your account with a code from an authenticator app on your phone (for example Google Authenticator or 1Password). It is required for the Taviron team."}
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
  const steps = ["Password", "Authenticator", "Join"];
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

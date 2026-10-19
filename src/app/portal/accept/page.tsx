import { createClient } from "@/server/supabase/server";
import { AcceptInviteForm } from "@/components/portal/portal-forms";
import { isPortalToken } from "@/lib/portal";

export const metadata = { title: { absolute: "Customer Portal Invitation" } };

/** Opening an invitation: shows whom it is for, then creates the account (new person) or links it (signed in). */
export default async function AcceptInvitation({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const supabase = await createClient();
  const valid = isPortalToken(token);
  const { data } = valid ? await supabase.rpc("portal_invite_peek", { p_token: token }) : { data: null };
  const invite = data as { email: string; company: string; customer: string; slug: string; expired: boolean; open: boolean } | null;
  const { data: claims } = await supabase.auth.getClaims();
  const signedInAs = claims?.claims?.email ? String(claims.claims.email) : null;

  return (
    <main id="main" className="app-root flex min-h-dvh items-center justify-center bg-surface px-4 py-10 text-ink">
      <div className="w-full max-w-md rounded-lg border border-line bg-card p-6">
        {!invite || invite.expired ? (
          <>
            <h1 className="text-xl font-bold">This invitation is not valid</h1>
            <p className="mt-2 text-sm text-muted">It may have been used already or expired after 7 days. Ask the company for a new invitation.</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold">{invite.company} Customer Portal</h1>
            <p className="mt-2 text-sm text-muted">
              You are invited to follow orders, deliveries and quotes for <strong className="text-ink">{invite.customer}</strong>.
            </p>
            {!invite.open ? <p className="mt-3 rounded-md bg-surface p-3 text-sm text-muted">The portal is not open yet. You can set up your account now and sign in once it opens.</p> : null}
            {!signedInAs && invite.open ? (
              <p className="mt-3 text-sm text-muted">
                Already have an account? <a href={`/portal/${invite.slug}/login`} className="font-semibold text-brand-fg hover:underline">Sign in</a>, then open this link again.
              </p>
            ) : null}
            {signedInAs && signedInAs.toLowerCase() !== invite.email.toLowerCase() ? (
              <p className="mt-4 rounded-md bg-surface p-3 text-sm text-ink">
                You are signed in as {signedInAs}, but this invitation is for {invite.email}. Sign out first, then open the link again.
              </p>
            ) : (
              <div className="mt-5">
                <AcceptInviteForm token={token as string} email={invite.email} signedInAs={signedInAs} />
              </div>
            )}
          </>
        )}
        <p className="mt-6 text-xs text-muted"><a href="https://mytaviron.com/" className="hover:underline">Powered by Taviron</a></p>
      </div>
    </main>
  );
}

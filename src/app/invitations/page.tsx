import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { buttonClasses } from "@/components/ui/button";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { ROLE_LABELS } from "@/lib/permissions";
import { requireSignedIn } from "@/server/auth";
import { createClient } from "@/server/supabase/server";
import { answerInvitation } from "./actions";

export const metadata = { title: "Invitations" };

type Invitation = { id: string; company_name: string; role: string; invited_by: string; created_at: string };

/**
 * Companies that invited this sign-in (security review 2026-11-06, M1): nobody is added to a company without accepting.
 * Reachable with or without a company of one's own.
 */
export default async function InvitationsPage({ searchParams }: { searchParams: Promise<{ error?: string; declined?: string }> }) {
  const access = await requireSignedIn();
  const sp = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_membership_invitations");
  const rows = (error ? [] : data ?? []) as Invitation[];
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-lg rounded-panel border border-line/70 bg-card p-6 shadow-card">
        <div className="mb-4 flex justify-center"><BrandMark tone="dark" /></div>
        <h1 className="text-lg font-bold">Invitations</h1>
        <p className="mt-1 text-sm text-muted">Signed in as {access.email}. A company can add you only when you accept.</p>
        {sp.error ? <div className="mt-4"><Notice tone="warning" title="Not done">{sp.error}</Notice></div> : null}
        {sp.declined ? <div className="mt-4"><Notice title="Declined">The company was told nothing beyond that the invitation was declined.</Notice></div> : null}
        {rows.length === 0 ? (
          <p className="mt-5 text-sm text-muted">No invitations are waiting.</p>
        ) : (
          <ul className="mt-5 space-y-3" aria-label="Invitations waiting">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl border border-line p-4">
                <p className="font-semibold text-ink">{r.company_name}</p>
                <p className="text-sm text-muted">As {ROLE_LABELS[r.role as keyof typeof ROLE_LABELS] ?? r.role}, invited by {r.invited_by} on {formatDateTime(r.created_at)}.</p>
                <form action={answerInvitation} className="mt-3 flex gap-2">
                  <input type="hidden" name="invitation" value={r.id} />
                  <SubmitButton name="answer" value="accept">Accept</SubmitButton>
                  <SubmitButton name="answer" value="decline" variant="secondary">Decline</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex justify-center">
          <Link href={access.companyId ? "/command-center" : "/no-access"} className={buttonClasses("secondary")}>{access.companyId ? "Back to Taviron" : "Back"}</Link>
        </div>
      </div>
    </main>
  );
}

import { redirect } from "next/navigation";
import { PortalUnavailable } from "@/components/portal/portal-unavailable";
import { PortalForgotPasswordForm } from "@/components/portal/portal-forms";
import { portalGate } from "@/server/portal";

export const metadata = { title: "Reset Your Password" };

/** Portal password reset (owner 2026-11-17, PR1): for sign-ins invited by email; usernames ask the company. */
export default async function PortalForgotPassword({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await portalGate(slug);
  if (gate.kind === "customer") redirect(`/portal/${slug}`);
  if (!gate.company) return <PortalUnavailable />;
  const name = gate.company.name;
  return (
    <div className="mx-auto max-w-sm rounded-panel border border-line/70 bg-card shadow-card p-6">
      <h1 className="mb-1 text-xl font-bold text-ink">Reset Your Password</h1>
      <p className="mb-5 text-sm text-muted">
        Type the email you sign in to the {name} customer portal with. We will email you a link to choose a new password.
      </p>
      <PortalForgotPasswordForm slug={slug} company={name} />
      <p className="mt-4 rounded-xl bg-surface p-3 text-sm text-muted">
        Sign in with a username instead of an email? A username has no email address, so no link can be sent. Ask {name} for a new sign-in.
      </p>
    </div>
  );
}

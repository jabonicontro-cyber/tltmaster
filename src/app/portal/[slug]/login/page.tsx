import { redirect } from "next/navigation";
import { PortalUnavailable } from "@/components/portal/portal-unavailable";
import { PortalLoginForm } from "@/components/portal/portal-forms";
import { portalGate } from "@/server/portal";

export const metadata = { title: "Sign In" };

export default async function PortalLogin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ next?: string }> }) {
  const { slug } = await params;
  const { next } = await searchParams;
  const gate = await portalGate(slug);
  if (gate.kind === "customer") redirect(`/portal/${slug}`);
  if (!gate.company) {
    return <PortalUnavailable />;
  }
  return (
    <div className="mx-auto max-w-sm rounded-lg border border-line bg-card p-6">
      <h1 className="mb-1 text-xl font-bold text-ink">Sign In</h1>
      <p className="mb-5 text-sm text-muted">to the {gate.company.name} customer portal</p>
      {gate.kind === "no-access" ? (
        <p className="mb-4 rounded-md bg-surface p-3 text-sm text-muted">The account you are signed in with has no access here. Sign in with the email {gate.company.name} invited.</p>
      ) : null}
      <PortalLoginForm slug={slug} next={next} />
      <p className="mt-4 text-center text-sm text-muted">No account yet? Ask {gate.company.name} for an invitation.</p>
    </div>
  );
}

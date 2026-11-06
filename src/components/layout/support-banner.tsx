import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import type { Access } from "@/lib/permissions";
import { leaveCompany } from "@/app/staff/actions";

/**
 * Taviron support visits (SA1). Staff inside a company see whose account they are in, until when, and Leave; the
 * company's owners see that Taviron support is in their account and where to end it. Never dismissible. Also: invitations
 * from other companies waiting for this sign-in (M1).
 */
export function SupportBanner({ access, timeZone, invitations = [] }: { access: Access; timeZone?: string; invitations?: string[] }) {
  if (access.support) {
    return (
      <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm shadow-xs" aria-label="Taviron support visit">
        <LifeBuoy className="size-5 shrink-0 text-brand-fg" aria-hidden />
        <p className="min-w-0 flex-1 text-ink">
          <span className="font-semibold">You are in {access.companyName ?? "this company"} as Taviron support</span>
          <span className="text-muted"> until {formatDateTime(access.support.endsAt, timeZone)}. You have the owner&apos;s permissions; your changes show as yours with &quot;(Taviron support)&quot;.</span>
        </p>
        <form action={leaveCompany}><SubmitButton variant="secondary" size="sm">Leave</SubmitButton></form>
      </div>
    );
  }
  if (access.supportInside) {
    return (
      <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm shadow-xs" aria-label="Taviron support is in your account">
        <LifeBuoy className="size-5 shrink-0 text-brand-fg" aria-hidden />
        <p className="min-w-0 flex-1 text-ink"><span className="font-semibold">Taviron support is in your account.</span> <span className="text-muted">Their changes show in history with &quot;(Taviron support)&quot;.</span></p>
        <Link href="/settings?tab=support" className="font-semibold text-brand-fg hover:underline">Manage access</Link>
      </div>
    );
  }
  if (invitations.length) {
    return (
      <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm shadow-xs" aria-label="Invitations waiting">
        <p className="min-w-0 flex-1 text-ink"><span className="font-semibold">{invitations.length === 1 ? `${invitations[0]} invited you to join them.` : `${invitations.length} companies invited you to join them.`}</span> <span className="text-muted">You join only if you accept.</span></p>
        <Link href="/invitations" className="font-semibold text-brand-fg hover:underline">See invitations</Link>
      </div>
    );
  }
  return null;
}
